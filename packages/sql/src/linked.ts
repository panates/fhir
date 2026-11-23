/**
 * A child over sqb entities: the rows of a `@Link().toMany(...)` field of
 * the parent's entity, read and written with sqb's Repository, so that the
 * entities' own column names, types and transforms apply. For an
 * application that already describes its tables as sqb entities.
 */
import { And, Eq, In, Raw, Select } from '@sqb/builder';
import {
  EntityMetadata,
  type Repository,
  prepareEntityFilter,
} from '@sqb/connect';
import { FhirServerError } from '@fhirjs/server';
import type { SqlChild } from './children.js';

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
}

/** The alias the conditions' SQL is written on, replaced by a search's */
const ALIAS = 'fhir_link__';

const quoteKey = (row: Row, key: readonly string[]) =>
  JSON.stringify(key.map(k => (row[k] == null ? null : String(row[k]))));

/**
 * The child of the parent entity's `@Link().toMany(...)` field `field`. The
 * link is one hop from the parent's id column (the table's `id`) to a
 * column of the child, with conditions of its own or not (`where`): two
 * links can share a table (`phones` where kind is phone, `emails` where it
 * is email), each reading, writing and deleting its own rows only. A
 * parameter over its rows names the child's columns, not its properties,
 * and is limited by the link's conditions.
 */
export function linked(
  parent: Ctor,
  field: string,
  options: LinkedOptions = {},
): SqlChild {
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
      if (!a.returnsMany() || a.next)
        throw new TypeError(
          `linked(${parent.name}, ${field}): the link must be one toMany hop`,
        );
      const target = await a.resolveTarget();
      const fk = await a.resolveTargetProperty();
      const primary = EntityMetadata.getPrimaryIndexColumns(target).map(
        c => c.name,
      );
      if (options.key?.length && options.rows && !primary.length)
        throw new TypeError(
          `linked(${parent.name}, ${field}): ${target.name} needs a primary key to be written by a key`,
        );
      const table = target.tableName || target.name;
      const qualified = target.schema ? `${target.schema}.${table}` : table;
      const conditions = a.conditions ?? [];
      // the conditions as SQL of the child's columns on an alias, as sqb
      // writes them; a search puts its own alias in its place
      let conditionSql: string | undefined;
      if (conditions.length) {
        const op = await prepareEntityFilter(target, conditions, ALIAS);
        const { sql } = Select(Raw('1'))
          .from(`${qualified} ${ALIAS}`)
          .where(op)
          .generate();
        conditionSql = sql.slice(sql.indexOf(' where ') + 7);
      }
      resolved = {
        target: target.ctor as Ctor,
        table: qualified,
        fkProperty: fk.name,
        fkColumn: fk.fieldName,
        primary,
        conditions,
        conditionSql,
      };
    },

    async read(parentIds, db) {
      const byParent = new Map<string, Row[]>();
      if (!parentIds.length) return byParent;
      const { fkProperty } = r();
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
      const { table, fkColumn, conditionSql } = r();
      const on = `${alias}.${fkColumn} = ${parentId}`;
      return {
        table,
        on: conditionSql
          ? `${on} and ${conditionSql.replaceAll(`${ALIAS}.`, `${alias}.`)}`
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

    async remove(parentId, db) {
      await repo(db).deleteMany({ filter: ofParent(parentId) });
    },
  };
}
