/**
 * A store over an existing database, described table by table: reads and
 * searches translated to SQL with sqb.
 */
import { And, Eq, Exists, Not, Or, Raw, Select } from '@sqb/builder';
import type { SqbClient } from '@sqb/connect';
import {
  type FhirStore,
  FhirServerError,
  type SearchCriterion,
  type SearchQuery,
  type StoreCapabilities,
  type StorePage,
  type StoredResource,
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

/** A resource type kept in a table */
export interface SqlTable {
  /** The table, with its schema if need be */
  table: string;
  /** The column of the resource's id; `id` by default */
  id?: Column;
  /** The column of `meta.lastUpdated`, for `_lastUpdated` */
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
}

/**
 * A store over the tables of an existing database. It reads and searches;
 * the rows are mapped to resources by the code of each table.
 */
export class SqlStore implements FhirStore {
  private readonly _client: SqbClient;
  private readonly _dialect: SqlDialect;
  private readonly _types = new Map<string, Resolved>();

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
      this._types.set(type, { def, params, sort });
    }
  }

  capabilities(type: string): StoreCapabilities | undefined {
    const t = this._types.get(type);
    if (!t) return;
    return {
      interactions: ['read', 'search'],
      versions: 'none',
      searchParams: Object.keys(t.params),
      sort: Object.keys(t.sort),
      chains: target => this._types.has(target),
    };
  }

  async read(type: string, id: string): Promise<StoredResource | undefined> {
    const t = this._types.get(type)!;
    const p = new SqlParams();
    const query = Select(Raw(t.def.select('t')))
      .from(`${t.def.table} t`)
      .where(
        Eq(
          Raw(this._dialect.text(columnSql(t.def.id ?? 'id', 't'))),
          p.add(id),
        ),
      );
    const [row] = await this._rows(query, p);
    return row && stored(type, t.def.resource(row));
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
      columnSql(t.def.id ?? 'id', 't'),
    ].join(', ');
    const select = Select(Raw(t.def.select('t')))
      .from(`${t.def.table} t`)
      .where(...where)
      .orderBy(Raw(order) as any)
      .limit(query.count)
      .offset(query.offset);
    const count = Select(Raw('cast(count(*) as int) as n'))
      .from(`${t.def.table} t`)
      .where(...where);
    const rows = await this._rows(select, p);
    const [{ n }] = await this._rows(count, p);
    return {
      items: rows.map(r => stored(type, t.def.resource(r))),
      total: n,
    };
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
              Raw(columnSql(target.def.id ?? 'id', inner.alias)),
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
              Raw(columnSql(t.def.id ?? 'id', ctx.alias)),
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
    query: ReturnType<typeof Select>,
    p: SqlParams,
  ): Promise<Record<string, any>[]> {
    const result = await this._client.execute(query, {
      params: { ...p.values },
      objectRows: true,
    });
    return (result.rows ?? []) as Record<string, any>[];
  }
}

function stored(type: string, resource: Record<string, any>): StoredResource {
  return {
    type,
    id: resource.id,
    resource,
    lastUpdated: resource.meta?.lastUpdated,
  };
}
