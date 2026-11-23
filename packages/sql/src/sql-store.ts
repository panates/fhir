/**
 * A store over an existing database, described table by table: reads,
 * searches and writes translated to SQL with sqb.
 */
import {
  And,
  Delete,
  Eq,
  Exists,
  Insert,
  Not,
  Or,
  type Query,
  Raw,
  Select,
  Update,
} from '@sqb/builder';
import type { SqbClient, SqbConnection } from '@sqb/connect';
import {
  type FhirStore,
  type FhirStoreInteraction,
  FhirServerError,
  type SearchCriterion,
  type SearchQuery,
  type StoreCapabilities,
  type StorePage,
  type StoredResource,
  type StoredVersion,
} from '@fhirjs/server';
import {
  type Column,
  type Cond,
  type CustomParam,
  type ParamSql,
  type SqlContext,
  FALSE,
  SqlParams,
  code,
  columnSql,
  instant,
  date,
  token,
} from './columns.js';
import { type SqlDialect, postgres } from './dialect.js';
import { type SqlRunner, lostElements, notKept } from './writes.js';

/** A resource type kept in a table */
export interface SqlTable {
  /** The table, with its schema if need be */
  table: string;
  /** The column of the resource's id; `id` by default */
  id?: Column;
  /**
   * The column of `meta.lastUpdated`, for `_lastUpdated`. When the table is
   * written and this is a column name, the store sets it on every write and
   * the resource's versionId is its milliseconds: If-Match is checked.
   */
  lastUpdated?: Column;
  /** The select list of a row of the alias: the columns `resource()` reads */
  select(alias: string): string;
  /** A row to its resource */
  resource(row: Record<string, any>): Record<string, any>;
  /** The search parameters it answers, by code; `_id` and `_lastUpdated` come from `id` and `lastUpdated` */
  params?: Record<string, ParamSql | CustomParam>;
  /**
   * The parameters it can be sorted by: a code, its key taken from the
   * parameter's kind, or a code and a key of its own
   */
  sort?: readonly (string | SqlSortKey)[];
  /**
   * A resource to the table's columns, for create and update; without it,
   * the type is read-only. It gives every column it maps, null where the
   * resource has no value (an update replaces the resource), and refuses
   * (FhirServerError 422) an element it cannot keep: `onlyElements()`. The
   * store sets the id and `lastUpdated` columns, then reads the row back and
   * refuses the write when an element did not come back. `db` runs SQL in
   * the write's transaction, for a code kept in a table of its own.
   */
  row?(
    resource: Record<string, any>,
    db: SqlRunner,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
}

/** A sort key of its own: SQL of the row of the alias */
export interface SqlSortKey {
  param: string;
  key(alias: string, descending: boolean): string;
}

export interface SqlStoreOptions {
  /** An sqb client of the database */
  client: SqbClient;
  /** The tables, by resource type */
  types: Record<string, SqlTable>;
  /** The SQL of the database; PostgreSQL by default */
  dialect?: SqlDialect;
}

interface Resolved {
  def: SqlTable;
  params: Record<string, ParamSql | CustomParam>;
  sort: Record<string, (ctx: SqlContext, descending: boolean) => string>;
  /** The id column */
  id: Column;
  /** Written with a version from `lastUpdated` */
  versioned: boolean;
}

/** Where queries run: the pool, or the connection of a transaction */
type Db = Pick<SqbClient, 'execute'> | SqbConnection;

/** The column the version is read into, beside the table's own */
const VERSION = 'fhir_version__';

/**
 * A store over the tables of an existing database. It reads and searches,
 * and writes the tables that map a resource back to a row; the rows are
 * mapped to resources by the code of each table. Every write is a database
 * transaction, and `transaction()` runs a transaction Bundle in one.
 */
export class SqlStore implements FhirStore {
  private readonly _client: SqbClient;
  private readonly _dialect: SqlDialect;
  private readonly _types = new Map<string, Resolved>();
  /** The connection of the transaction this view runs in */
  private _connection?: SqbConnection;

  constructor(options: SqlStoreOptions) {
    this._client = options.client;
    this._dialect = options.dialect ?? postgres;
    for (const [type, def] of Object.entries(options.types)) {
      const id = def.id ?? 'id';
      const params: Record<string, ParamSql | CustomParam> = {
        _id: token(code(a => this._dialect.text(columnSql(id, a)))),
        ...(def.lastUpdated && {
          _lastUpdated: date(instant(def.lastUpdated)),
        }),
        ...def.params,
      };
      const sort: Resolved['sort'] = {};
      for (const s of def.sort ?? []) {
        if (typeof s !== 'string') {
          sort[s.param] = (ctx, desc) => s.key(ctx.alias, desc);
          continue;
        }
        const p = params[s];
        const key = typeof p === 'object' ? p.sort : undefined;
        if (!key)
          throw new TypeError(
            `${type}: ${s} has no sort key of its kind; give one with { param, key }`,
          );
        sort[s] = key;
      }
      if (def.row && typeof id !== 'string')
        throw new TypeError(
          `${type}: a table that is written needs its id as a column name`,
        );
      const versioned = !!def.row && typeof def.lastUpdated === 'string';
      this._types.set(type, { def, params, sort, id, versioned });
    }
  }

  capabilities(type: string): StoreCapabilities | undefined {
    const t = this._types.get(type);
    if (!t) return;
    const writes: FhirStoreInteraction[] = t.def.row
      ? ['create', 'update', 'delete']
      : [];
    return {
      interactions: ['read', 'search', ...writes],
      versions: t.versioned ? 'current' : 'none',
      searchParams: Object.keys(t.params),
      sort: Object.keys(t.sort),
      chains: target => this._types.has(target),
    };
  }

  async read(type: string, id: string): Promise<StoredResource | undefined> {
    return this._read(this._db, type, id);
  }

  private async _read(
    db: Db,
    type: string,
    id: string,
  ): Promise<StoredResource | undefined> {
    const t = this._types.get(type)!;
    const p = new SqlParams();
    const query = Select(Raw(this._select(t, 't')))
      .from(`${t.def.table} t`)
      .where(this._idIs(t, 't', p.add(id)));
    const [row] = await this._rows(db, query, p.values);
    return row && this._stored(type, t, row);
  }

  async search(
    type: string,
    query: SearchQuery,
  ): Promise<StorePage<StoredResource>> {
    const t = this._types.get(type)!;
    const p = new SqlParams();
    const aliases = { n: 0 };
    const ctx = this._ctx('t', p);
    const where = query.criteria.map(c => this._criterion(c, t, ctx, aliases));
    const order = [
      ...query.sort.map(s => {
        const key = t.sort[s.param.code];
        if (!key) throw new FhirServerError(400, `No sort by ${s.param.code}`);
        return `${key(ctx, s.descending)} ${s.descending ? 'desc' : 'asc'} nulls last`;
      }),
      columnSql(t.id, 't'),
    ].join(', ');
    const select = Select(Raw(this._select(t, 't')))
      .from(`${t.def.table} t`)
      .where(...where)
      .orderBy(Raw(order) as any)
      .limit(query.count)
      .offset(query.offset);
    const count = Select(Raw('cast(count(*) as int) as n'))
      .from(`${t.def.table} t`)
      .where(...where);
    const rows = await this._rows(this._db, select, p.values);
    const [{ n }] = await this._rows(this._db, count, p.values);
    return {
      items: rows.map(r => this._stored(type, t, r)),
      total: n,
    };
  }

  async create(
    type: string,
    resource: Record<string, any>,
  ): Promise<StoredVersion> {
    const t = this._types.get(type)!;
    return this._atomic(type, 'create', async db => {
      const columns = await this._columns(db, t, resource, Date.now());
      const p = new SqlParams();
      const insert = Insert(t.def.table, valuesOf(columns, p)).returning(
        t.id as string,
      );
      const [row] = await this._rows(db, insert, p.values);
      return this._readBack(
        db,
        type,
        String(Object.values(row)[0]),
        resource,
        'POST',
      );
    });
  }

  async update(
    type: string,
    id: string,
    resource: Record<string, any>,
    ifMatch?: string,
  ): Promise<StoredVersion | undefined> {
    const t = this._types.get(type)!;
    return this._atomic(type, 'update', async db => {
      const current = await this._lock(db, t, type, id, ifMatch);
      if (current === undefined) return;
      // a version after the current one, even within its millisecond
      const columns = await this._columns(
        db,
        t,
        resource,
        Math.max(Date.now(), Number(current) + 1),
      );
      const p = new SqlParams();
      await this._rows(
        db,
        Update(t.def.table, valuesOf(columns, p)).where(
          this._idIs(t, undefined, p.add(id)),
        ),
        p.values,
      );
      return this._readBack(db, type, id, resource, 'PUT');
    });
  }

  async delete(
    type: string,
    id: string,
    ifMatch?: string,
  ): Promise<StoredVersion | undefined> {
    const t = this._types.get(type)!;
    return this._atomic(type, 'delete', async db => {
      if ((await this._lock(db, t, type, id, ifMatch)) === undefined) return;
      const p = new SqlParams();
      await this._rows(
        db,
        Delete(t.def.table).where(this._idIs(t, undefined, p.add(id))),
        p.values,
      );
      return { type, id, method: 'DELETE' as const };
    });
  }

  async transaction<T>(work: (tx: FhirStore) => Promise<T>): Promise<T> {
    return this._client.acquire(async (connection: SqbConnection) => {
      await connection.startTransaction();
      const view: SqlStore = Object.create(this);
      view._connection = connection;
      (view as any).transaction = undefined;
      try {
        const result = await work(view);
        await connection.commit();
        return result;
      } catch (e) {
        await connection.rollback();
        throw e;
      }
    });
  }

  private get _db(): Db {
    return this._connection ?? this._client;
  }

  /**
   * Runs a write in a transaction: the one of this view, or one of its own;
   * a refusal of the database becomes the answer to the client
   */
  private async _atomic<T>(
    type: string,
    interaction: 'create' | 'update' | 'delete',
    write: (db: Db) => Promise<T>,
  ): Promise<T> {
    const run = async (db: Db) => {
      try {
        return await write(db);
      } catch (e) {
        throw this._refused(e, type, interaction);
      }
    };
    if (this._connection) return run(this._connection);
    return this._client.acquire(async (connection: SqbConnection) => {
      await connection.startTransaction();
      try {
        const result = await run(connection);
        await connection.commit();
        return result;
      } catch (e) {
        await connection.rollback();
        throw e;
      }
    });
  }

  private _refused(
    e: unknown,
    type: string,
    interaction: 'create' | 'update' | 'delete',
  ): unknown {
    switch (this._dialect.refusal(e)) {
      case 'unique':
        return new FhirServerError(
          409,
          `A ${type} with the same unique value exists`,
          'duplicate',
        );
      case 'reference':
        return interaction === 'delete'
          ? new FhirServerError(
              409,
              `The ${type} is referred to by other rows of the database`,
              'conflict',
            )
          : new FhirServerError(
              422,
              `The ${type} refers to a row the database does not have`,
              'invalid',
            );
      case 'invalid':
        return new FhirServerError(
          422,
          `The database refused a value of the ${type}`,
          'invalid',
        );
      default:
        return e;
    }
  }

  /**
   * Locks the row to write and checks If-Match: its version, '' for a table
   * without versions, undefined when there is no row
   */
  private async _lock(
    db: Db,
    t: Resolved,
    type: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<string | undefined> {
    if (!t.def.row)
      throw new FhirServerError(405, `${type} is not written`, 'not-supported');
    const version = t.versioned
      ? this._dialect.epochMillis(columnSql(t.def.lastUpdated!, 't'))
      : `''`;
    const [row] = await this._rows(
      db,
      `select ${version} as v from ${t.def.table} t
        where ${this._dialect.text(columnSql(t.id, 't'))} = :id for update`,
      { id },
    );
    if (!row) return;
    if (ifMatch !== undefined && t.versioned && row.v !== ifMatch)
      throw new FhirServerError(
        412,
        `If-Match: ${type}/${id} is at version ${row.v}, not ${ifMatch}`,
        'conflict',
      );
    return row.v as string;
  }

  /** The resource's columns from the table's row(), with lastUpdated */
  private async _columns(
    db: Db,
    t: Resolved,
    resource: Record<string, any>,
    now: number,
  ): Promise<Record<string, unknown>> {
    const runner: SqlRunner = {
      rows: async (sql, params) => this._rows(db, sql, params ?? {}),
    };
    const columns = { ...(await t.def.row!(resource, runner)) };
    if (t.versioned) columns[t.def.lastUpdated as string] = new Date(now);
    return columns;
  }

  /** The row written, read back: refused when an element of the resource is not in it */
  private async _readBack(
    db: Db,
    type: string,
    id: string,
    written: Record<string, any>,
    method: 'POST' | 'PUT',
  ): Promise<StoredVersion> {
    const s = (await this._read(db, type, id))!;
    const lost = lostElements(written, s.resource!);
    if (lost.length) throw notKept(type, lost);
    return { ...s, method };
  }

  /** The select list of the table, with the version when it has one */
  private _select(t: Resolved, alias: string): string {
    const list = t.def.select(alias);
    return t.versioned
      ? `${list}, ${this._dialect.epochMillis(
          columnSql(t.def.lastUpdated!, alias),
        )} as ${VERSION}`
      : list;
  }

  /** The row's id is the value: compared as text */
  private _idIs(t: Resolved, alias: string | undefined, value: unknown): Cond {
    const id = t.id;
    const column =
      alias === undefined && typeof id === 'string'
        ? id
        : columnSql(id, alias!);
    return Eq(Raw(this._dialect.text(column)), value) as unknown as Cond;
  }

  private _stored(
    type: string,
    t: Resolved,
    row: Record<string, any>,
  ): StoredResource {
    const { [VERSION]: versionId, ...rest } = row;
    const resource = t.def.resource(rest);
    if (versionId === undefined) return stored(type, resource);
    resource.meta = { ...resource.meta, versionId };
    return { ...stored(type, resource), versionId };
  }

  private _ctx(alias: string, params: SqlParams): SqlContext {
    return { alias, params, dialect: this._dialect };
  }

  /** One criterion as a condition on the row of `ctx.alias` */
  private _criterion(
    c: SearchCriterion,
    t: Resolved,
    ctx: SqlContext,
    aliases: { n: number },
  ): Cond {
    if (c.chain) {
      const ref = this._reference(t, c.param.code);
      if (!ref || ref.target !== c.chain.type) return FALSE;
      const target = this._types.get(ref.target)!;
      const inner = this._ctx(`c${++aliases.n}`, ctx.params);
      return Exists(
        Select(Raw('1'))
          .from(`${target.def.table} ${inner.alias}`)
          .where(
            Eq(
              Raw(columnSql(target.id, inner.alias)),
              Raw(columnSql(ref.fk, ctx.alias)),
            ),
            ...c.chain.criteria.map(k =>
              this._criterion(k, target, inner, aliases),
            ),
          ),
      ) as unknown as Cond;
    }
    if (c.has) {
      const from = this._types.get(c.has.type);
      const ref = from && this._reference(from, c.param.code);
      if (!ref || this._types.get(ref.target) !== t) return FALSE;
      const inner = this._ctx(`h${++aliases.n}`, ctx.params);
      return Exists(
        Select(Raw('1'))
          .from(`${from.def.table} ${inner.alias}`)
          .where(
            Eq(
              Raw(columnSql(ref.fk, inner.alias)),
              Raw(columnSql(t.id, ctx.alias)),
            ),
            ...c.has.criteria.map(k =>
              this._criterion(k, from, inner, aliases),
            ),
          ),
      ) as unknown as Cond;
    }
    const param = t.params[c.param.code];
    if (!param) throw new FhirServerError(400, `No search by ${c.param.code}`);
    if (typeof param === 'function') return param(ctx, c);
    // a composite on one row: its parts are the row's parameters of its components
    const parts = c.components?.map(k => {
      const part = t.params[k.param.code];
      if (typeof part !== 'object')
        throw new FhirServerError(
          400,
          `${c.param.code}: its part ${k.param.code} is not searched by kind`,
          'not-supported',
        );
      return part;
    });
    if (c.missing !== undefined) {
      const present = parts
        ? And(...parts.map(s => s.present(ctx)))
        : param.present(ctx);
      return (c.missing ? Not(present) : present) as unknown as Cond;
    }
    if (parts)
      return Or(
        ...c.values.map(v =>
          And(
            ...parts.map((s, i) => s.value(ctx, v.components![i], undefined)),
          ),
        ),
      ) as unknown as Cond;
    const any = Or(...c.values.map(v => param.value(ctx, v, c.modifier)));
    return (c.modifier === 'not' ? Not(any) : any) as unknown as Cond;
  }

  private _reference(t: Resolved, code: string) {
    const p = t.params[code];
    return typeof p === 'object' ? p.reference : undefined;
  }

  private async _rows(
    db: Db,
    query: Query | string,
    params: Record<string, unknown>,
  ): Promise<Record<string, any>[]> {
    const result = await db.execute(query, {
      params: { ...params },
      objectRows: true,
    });
    return (result.rows ?? []) as Record<string, any>[];
  }
}

/** Columns to values as parameters: sqb would write a Date into the SQL text */
function valuesOf(
  columns: Record<string, unknown>,
  p: SqlParams,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(columns))
    values[k] = p.add(v === undefined ? null : v);
  return values;
}

function stored(type: string, resource: Record<string, any>): StoredResource {
  return {
    type,
    id: resource.id,
    resource,
    lastUpdated: resource.meta?.lastUpdated,
  };
}
