/**
 * A child over sqb entities: the rows of a `@Link().toMany(...)` field of
 * the parent's entity, read and written with sqb's Repository, so that the
 * entities' own column names, types and transforms apply. For an
 * application that already describes its tables as sqb entities.
 */
import { FhirServerError } from '@fhirjs/server';
import { And, Eq, In, Raw, Select } from '@sqb/builder';
import {
  EntityMetadata,
  prepareEntityFilter,
  type Repository,
} from '@sqb/connect';
import type { SqlChild } from './children.js';
import type { Column } from './columns.js';

type Row = Record<string, any>;
type Ctor = new (...args: any[]) => any;

export interface LinkedOptions {
  /** The order of a parent's rows: properties of the child's entity, `-` before one for descending */
  sort?: readonly string[];
  /**
   * The properties that tell a parent's rows apart: a row the resource
   * still has (by its key) is updated, so it keeps its primary key and the
   * properties the resource does not map. The child's entity needs a
   * primary key. Without a key, a parent's rows are deleted and created
   * again.
   */
  key?: readonly string[];
  /**
   * The resource's rows, for writes: the child's properties but the
   * foreign key, null where the resource has no value. Without it, the
   * child is only read. A row of a link with conditions (`where`) gives
   * the properties they ask for (`kind: 'phone'`): one that does not meet
   * them is not read back, and the store refuses the resource.
   */
  rows?(resource: Row): Row[];
}

/** A hop of a link of more than one, for searches */
interface Hop {
  /** Its target's table */
  table: string;
  /** The column of its target that the key of the hop before is in */
  targetColumn: string;
  /** The column of the hop before (of the parent, for the first) it starts from */
  sourceColumn: string;
  /** Its conditions' SQL on the alias of the hop: `fhir_hop${i}__` */
  conditionSql?: string;
}

/** What the link resolves to: the child's entity and the columns that join it */
interface Resolved {
  target: Ctor;
  /** The table, with the entity's schema when it names one */
  table: string;
  /** The child's property and column of the parent's key */
  fkProperty: string;
  fkColumn: string;
  /** The child's primary key properties */
  primary: string[];
  /** The link's own conditions (`where`), of the child's properties */
  conditions: any[];
  /** Their SQL on the alias ALIAS, for searches */
  conditionSql?: string;
  /** A link of more than one hop: its hops, read through the parent's entity */
  hops?: Hop[];
  /** The parent entity's property of its key, for a link of more than one hop */
  parentKey?: string;
  /** The child's columns, by property */
  columns: Map<string, string>;
}

/** The alias the conditions' SQL is written on, replaced by a search's */
const ALIAS = 'fhir_link__';

const quoteKey = (row: Row, key: readonly string[]) =>
  JSON.stringify(key.map(k => (row[k] == null ? null : String(row[k]))));

/** A link's own conditions as SQL of its target's columns on an alias, as sqb writes them */
async function conditionSql(
  target: any,
  table: string,
  conditions: any[],
  alias: string,
): Promise<string | undefined> {
  if (!conditions.length) return;
  const op = await prepareEntityFilter(target, conditions, alias);
  const { sql } = Select(Raw('1'))
    .from(`${table} ${alias}`)
    .where(op)
    .generate();
  return sql.slice(sql.indexOf(' where ') + 7);
}

const qualified = (meta: any) => {
  const table = meta.tableName || meta.name;
  return meta.schema ? `${meta.schema}.${table}` : table;
};

/** A linked child, and the columns of its entity by property */
export type LinkedChild = SqlChild & {
  /**
   * The column of a property of the child's entity, for a parameter over
   * its rows: `code(phones.column('value'))`
   */
  column(property: string): Column;
};

/**
 * The child of the parent entity's `@Link().toMany(...)` field `field`. The
 * link is one hop from the parent's id column (the table's `id`) to a
 * column of the child, with conditions of its own or not (`where`): two
 * links can share a table (`phones` where kind is phone, `emails` where it
 * is email), each reading, writing and deleting its own rows only. A
 * parameter over its rows names the child's columns, not its properties,
 * and is limited by the link's conditions; `column(property)` gives one
 * by its property.
 *
 * A link of more than one hop (`toMany(Care).toOne(Doctor)`, through a
 * table between) is read through the parent's entity, as sqb follows it,
 * and searched; it is not written (`rows` is refused).
 */
export function linked(
  parent: Ctor,
  field: string,
  options: LinkedOptions = {},
): LinkedChild {
  let resolved: Resolved | undefined;
  const r = () => {
    if (!resolved)
      throw new TypeError(
        `linked(${parent.name}, ${field}) is used before the store prepared it`,
      );
    return resolved;
  };
  const repo = (db: { repository?: (e: Ctor) => Repository<any> }) => {
    if (!db.repository)
      throw new TypeError(
        `linked(${parent.name}, ${field}) needs the store's sqb connection`,
      );
    return db.repository(r().target);
  };
  /** The rows of a parent (or of parents), within the link's conditions */
  const rowsOf = (fk: any) =>
    r().conditions.length ? And(fk, ...r().conditions) : fk;
  const ofParent = (parentId: string) => rowsOf(Eq(r().fkProperty, parentId));
  const create = (rep: Repository<any>, parentId: string, row: Row) =>
    rep.createOnly({ ...row, [r().fkProperty]: parentId });

  return {
    async prepare() {
      if (resolved) return;
      const meta = EntityMetadata.get(parent);
      const link = meta && EntityMetadata.getAssociationField(meta, field);
      if (!link)
        throw new TypeError(
          `linked(${parent.name}, ${field}): ${parent.name} is not an entity with a link ${field}`,
        );
      const a = link.association;
      if (!a.returnsMany())
        throw new TypeError(
          `linked(${parent.name}, ${field}): the link must be toMany`,
        );
      if (a.next) {
        if (options.rows)
          throw new TypeError(
            `linked(${parent.name}, ${field}): a link of more than one hop is read, not written`,
          );
        const hops: Hop[] = [];
        let target: any;
        for (let node: any = a, i = 0; node; node = node.next, i++) {
          target = await node.resolveTarget();
          const table = qualified(target);
          hops.push({
            table,
            targetColumn: (await node.resolveTargetProperty()).fieldName,
            sourceColumn: (await node.resolveSourceProperty()).fieldName,
            conditionSql: await conditionSql(
              target,
              table,
              node.conditions ?? [],
              `fhir_hop${i}__`,
            ),
          });
        }
        resolved = {
          target: target.ctor as Ctor,
          table: hops.at(-1)!.table,
          fkProperty: '',
          fkColumn: '',
          primary: [],
          conditions: [],
          hops,
          parentKey: (await a.resolveSourceProperty()).name,
          columns: columnsOf(target),
        };
        return;
      }
      const target = await a.resolveTarget();
      const fk = await a.resolveTargetProperty();
      const primary = EntityMetadata.getPrimaryIndexColumns(target).map(
        c => c.name,
      );
      if (options.key?.length && options.rows && !primary.length)
        throw new TypeError(
          `linked(${parent.name}, ${field}): ${target.name} needs a primary key to be written by a key`,
        );
      const table = qualified(target);
      const conditions = a.conditions ?? [];
      resolved = {
        target: target.ctor as Ctor,
        table,
        fkProperty: fk.name,
        fkColumn: fk.fieldName,
        primary,
        conditions,
        // the conditions as SQL of the child's columns on an alias, as sqb
        // writes them; a search puts its own alias in its place
        conditionSql: await conditionSql(target, table, conditions, ALIAS),
        columns: columnsOf(target),
      };
    },

    column: property => alias => {
      const column = r().columns.get(property);
      if (!column)
        throw new TypeError(
          `linked(${parent.name}, ${field}): ${r().target.name} has no column property ${property}`,
        );
      return `${alias}.${column}`;
    },

    async read(parentIds, db) {
      const byParent = new Map<string, Row[]>();
      if (!parentIds.length) return byParent;
      const { fkProperty, hops, parentKey } = r();
      if (hops) {
        // through the parent's entity: sqb follows the hops and their conditions
        if (!db.repository)
          throw new TypeError(
            `linked(${parent.name}, ${field}) needs the store's sqb connection`,
          );
        const parents = (await db.repository(parent).findMany({
          filter: In(parentKey!, parentIds),
          projection: [parentKey!, field],
        })) as Row[];
        for (const p of parents) {
          const rows = [...((p[field] as Row[] | undefined) ?? [])];
          if (options.sort?.length) rows.sort(compareBy(options.sort));
          if (rows.length) byParent.set(String(p[parentKey!]), rows);
        }
        return byParent;
      }
      const rows = await repo(db).findMany({
        filter: rowsOf(In(fkProperty, parentIds)),
        sort: [fkProperty, ...(options.sort ?? [])],
      });
      for (const row of rows as Row[]) {
        const parentId = String(row[fkProperty]);
        const list = byParent.get(parentId);
        if (list) list.push(row);
        else byParent.set(parentId, [row]);
      }
      return byParent;
    },

    join: (parentId, alias) => {
      const { table, fkColumn, conditionSql: condition, hops } = r();
      if (hops) return { table, on: hopsOn(hops, parentId, alias) };
      const on = `${alias}.${fkColumn} = ${parentId}`;
      return {
        table,
        on: condition
          ? `${on} and ${condition.replaceAll(`${ALIAS}.`, `${alias}.`)}`
          : on,
      };
    },

    write: options.rows
      ? async (parentId, resource, db) => {
          const rep = repo(db);
          const rows = options.rows!(resource);
          const key = options.key;
          if (!key?.length) {
            await rep.deleteMany({ filter: ofParent(parentId) });
            for (const row of rows) await create(rep, parentId, row);
            return;
          }
          const wanted = new Map<string, Row>();
          for (const row of rows) {
            const k = quoteKey(row, key);
            if (wanted.has(k))
              throw new FhirServerError(
                422,
                `The ${resource.resourceType} has two elements the database cannot tell apart`,
                'not-supported',
              );
            wanted.set(k, row);
          }
          const { primary } = r();
          const current = (await rep.findMany({
            filter: ofParent(parentId),
            projection: [...new Set([...primary, ...key])],
          })) as Row[];
          const kept = new Set<string>();
          for (const row of current) {
            const k = quoteKey(row, key);
            const id =
              primary.length === 1
                ? row[primary[0]]
                : Object.fromEntries(primary.map(p => [p, row[p]]));
            const next = wanted.get(k);
            if (!next) {
              await rep.delete(id);
              continue;
            }
            kept.add(k);
            await rep.updateOnly(id, next);
          }
          for (const [k, row] of wanted)
            if (!kept.has(k)) await create(rep, parentId, row);
        }
      : undefined,

    remove: options.rows
      ? async (parentId, db) => {
          await repo(db).deleteMany({ filter: ofParent(parentId) });
        }
      : undefined,
  };
}

/** The column properties of an entity: property to column */
function columnsOf(meta: any): Map<string, string> {
  const columns = new Map<string, string>();
  for (const name of EntityMetadata.getColumnFieldNames(meta)) {
    const f = EntityMetadata.getColumnField(meta, name)!;
    columns.set(f.name, f.fieldName);
  }
  return columns;
}

/** Rows ordered by properties, `-` before one for descending */
function compareBy(sort: readonly string[]) {
  return (a: Row, b: Row) => {
    for (const s of sort) {
      const desc = s.startsWith('-');
      const k = desc ? s.slice(1) : s;
      const x = a[k];
      const y = b[k];
      if (x === y) continue;
      if (x == null) return desc ? 1 : -1;
      if (y == null) return desc ? -1 : 1;
      return (x < y ? -1 : 1) * (desc ? -1 : 1);
    }
    return 0;
  };
}

/**
 * That a row of the last hop (on `alias`) belongs to the parent whose id is
 * the SQL `parentId`: EXISTS the rows of the hops between, joined by their
 * keys, within each hop's conditions
 */
function hopsOn(hops: Hop[], parentId: string, alias: string): string {
  const aliasOf = (i: number) =>
    i === hops.length - 1 ? alias : `${alias}_h${i}`;
  const cond = (i: number) =>
    hops[i].conditionSql?.replaceAll(`fhir_hop${i}__.`, `${aliasOf(i)}.`);
  const between = hops.slice(0, -1);
  const from = between
    .map((h, i) =>
      i === 0
        ? `${h.table} ${aliasOf(0)}`
        : `join ${h.table} ${aliasOf(i)} on ${aliasOf(i)}.${h.targetColumn} = ${aliasOf(i - 1)}.${h.sourceColumn}`,
    )
    .join(' ');
  const last = hops.length - 1;
  const where = [
    `${aliasOf(0)}.${hops[0].targetColumn} = ${parentId}`,
    `${alias}.${hops[last].targetColumn} = ${aliasOf(last - 1)}.${hops[last].sourceColumn}`,
    ...hops.map((_, i) => cond(i)).filter(Boolean),
  ];
  return `exists (select 1 from ${from} where ${where.join(' and ')})`;
}
