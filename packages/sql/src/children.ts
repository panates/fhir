/**
 * Rows of a resource kept in tables of their own (a patient's telecoms, an
 * encounter's diagnoses). The store asks a child for its rows a page at a
 * time, joins it for a search, and hands it the resource to write; how it
 * does so is its own: `childTable()` for a table with a foreign key to the
 * parent, or code of the application for any other shape.
 */
import { FhirServerError } from '@fhirjs/server';
import type { ParamSql } from './columns.js';
import type { SqlRunner } from './writes.js';

type Row = Record<string, any>;

/** Rows of a resource in a table of their own */
export interface SqlChild {
  /** Called once, before the child is first used: what it must look up (sqb's metadata) */
  prepare?(): Promise<void>;
  /**
   * The rows of each parent, by the parent's id as text, in their order; a
   * parent without rows may be left out. Called once for a read and once
   * for a page of a search.
   */
  read(parentIds: string[], db: SqlRunner): Promise<Map<string, Row[]>>;
  /**
   * The child's table joined to the parent, for searches: the table (with
   * its schema if need be) and the condition that a row of `alias` belongs
   * to the parent whose id is the SQL `parentId`. Without it, the child's
   * rows cannot be searched.
   */
  join?(parentId: string, alias: string): { table: string; on: string };
  /**
   * Writes the parent's rows from the resource, after the parent's row:
   * the rows the resource no longer has deleted. Without it the child is
   * not written, and the store refuses a resource whose rows did not come
   * back.
   */
  write?(parentId: string, resource: Row, db: SqlRunner): Promise<void>;
  /**
   * Deletes the parent's rows before the parent is deleted; not needed
   * when the foreign key cascades
   */
  remove?(parentId: string, db: SqlRunner): Promise<void>;
  /**
   * Children of its rows (an address's lines), by name: read into each row
   * under the name, searched by `child('addresses.lines', ...)`
   */
  children?: Record<string, SqlChild>;
  /** The SQL of a row's id on `alias`, which its own children join to */
  rowId?(alias: string): string;
}

/** A search parameter over the rows of a child */
export interface ChildParam extends ParamSql {
  child: { name: string; param: ParamSql; where?: (alias: string) => string };
}

/**
 * A parameter answered from the rows of the child `name`: a resource
 * matches when one of its rows does, and has a value when one of its rows
 * has. `where` limits the rows (`a => \`${a}.system = 'phone'\``). Sorted by
 * the lowest of its rows' keys ascending, the highest descending. A child
 * of a child is named by its path: `addresses.lines`.
 */
export function child(
  name: string,
  param: ParamSql,
  where?: (alias: string) => string,
): ChildParam {
  // the store gives it its SQL; these are not called
  const unresolved = () => {
    throw new TypeError(`child(${name}) is used outside a SqlStore`);
  };
  return {
    child: { name, param, where },
    present: unresolved,
    value: unresolved,
  };
}

export interface ChildTableOptions {
  /** The table, with its schema if need be */
  table: string;
  /** The column of the parent's id */
  fk: string;
  /** The select list of a row of the alias: the columns the parent's `resource()` reads */
  select(alias: string): string;
  /** The order of a parent's rows: SQL of a row of the alias */
  order?(alias: string): string;
  /**
   * The columns that tell a parent's rows apart, text or codes: a row the
   * resource still has (by its key) is updated, so it keeps its own id and
   * columns the resource does not map
   */
  key?: readonly string[];
  /**
   * The resource's rows, for writes: every column mapped but the foreign
   * key, null where the resource has no value. Without it, the table is
   * only read. With `children`, a row gives under a child's name what that
   * child writes its rows from (the address its lines are of); it is not a
   * column.
   */
  rows?(resource: Row): Row[];
  /** The column of a row's id: needed with `children` */
  id?: string;
  /**
   * Children of the rows, by name (an address's lines): read into each row
   * under the name, written after their row, removed before it
   */
  children?: Record<string, SqlChild>;
}

/** The column the parent's id is read into */
const PARENT = 'fhir_parent__';
/** The column a row's own id is read into, for its children */
const ROW = 'fhir_row__';

const quoteKey = (row: Row, key: readonly string[]) =>
  JSON.stringify(key.map(k => (row[k] == null ? null : String(row[k]))));

/**
 * A child in a table with a foreign key to the parent's id. Writes match
 * the resource's rows to the table's by `key`: the same key is updated, a
 * new one inserted, one gone deleted. Without a key, the parent's rows are
 * deleted and inserted again.
 */
export function childTable(options: ChildTableOptions): SqlChild {
  const { table, fk, key, id } = options;
  const nested = Object.entries(options.children ?? {});
  if (nested.length && !id)
    throw new TypeError(
      `childTable(${table}): a table with children needs the column of its rows' id`,
    );
  /** The columns of a row: its children's names are not columns */
  const columnsOf = (row: Row) =>
    Object.keys(row).filter(c => !options.children?.[c]);
  /** A row's children written, from what the row gives under their names */
  const writeNested = async (rowId: string, row: Row, db: SqlRunner) => {
    for (const [name, c] of nested)
      if (c.write) await c.write(rowId, row[name] ?? {}, db);
  };
  /** A row's children removed, before the row */
  const removeNested = async (rowId: string, db: SqlRunner) => {
    for (const [, c] of nested) if (c.remove) await c.remove(rowId, db);
  };
  /** The ids of a parent's rows, to remove their children */
  const rowIds = async (db: SqlRunner, parentId: string) => {
    const params: Row = {};
    return (
      await db.rows(
        `select cast(${id} as text) as id from ${table} where ${ofParent(params, parentId)}`,
        params,
      )
    ).map(r => r.id as string);
  };
  const ofParent = (params: Row, parentId: string) => {
    params.parent = parentId;
    return `${fk} = :parent`;
  };
  const keyIs = (params: Row, row: Row) =>
    key!
      .map((k, i) => {
        params[`k${i}`] = String(row[k]);
        return `cast(${k} as text) = :k${i}`;
      })
      .join(' and ');
  const insert = async (db: SqlRunner, parentId: string, row: Row) => {
    const params: Row = { parent: parentId };
    const columns = columnsOf(row);
    columns.forEach((c, i) => (params[`v${i}`] = row[c] ?? null));
    const inserted = await db.rows(
      `insert into ${table} (${[fk, ...columns].join(', ')})
        values (:parent, ${columns.map((_, i) => `:v${i}`).join(', ')})${
          nested.length ? ` returning cast(${id} as text) as id` : ''
        }`,
      params,
    );
    if (nested.length) await writeNested(inserted[0].id, row, db);
  };
  return {
    async read(parentIds, db) {
      const byParent = new Map<string, Row[]>();
      if (!parentIds.length) return byParent;
      const params: Row = {};
      const list = parentIds
        .map((id, i) => {
          params[`p${i}`] = id;
          return `:p${i}`;
        })
        .join(', ');
      const order = options.order ? `, ${options.order('c')}` : '';
      const rowId = nested.length ? `, cast(c.${id} as text) as ${ROW}` : '';
      const rows = await db.rows(
        `select cast(c.${fk} as text) as ${PARENT}${rowId}, ${options.select('c')}
          from ${table} c where c.${fk} in (${list}) order by c.${fk}${order}`,
        params,
      );
      // the rows' children, a read each for all of the rows
      const ofRows = await Promise.all(
        nested.map(([, c]) =>
          c.read(
            rows.map(r => r[ROW]),
            db,
          ),
        ),
      );
      for (const { [PARENT]: parent, [ROW]: own, ...row } of rows) {
        nested.forEach(([name], i) => (row[name] = ofRows[i].get(own) ?? []));
        const list = byParent.get(parent);
        if (list) list.push(row);
        else byParent.set(parent, [row]);
      }
      return byParent;
    },
    join: (parentId, alias) => ({
      table,
      on: `${alias}.${fk} = ${parentId}`,
    }),
    children: options.children,
    rowId: id ? alias => `${alias}.${id}` : undefined,
    write: options.rows
      ? async (parentId, resource, db) => {
          const rows = options.rows!(resource);
          if (!key?.length) {
            if (nested.length)
              for (const rowId of await rowIds(db, parentId))
                await removeNested(rowId, db);
            const params: Row = {};
            await db.rows(
              `delete from ${table} where ${ofParent(params, parentId)}`,
              params,
            );
            for (const row of rows) await insert(db, parentId, row);
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
          const params: Row = {};
          const current = await db.rows(
            `select ${[
              ...key.map(k => `cast(${k} as text) as ${k}`),
              ...(nested.length ? [`cast(${id} as text) as ${ROW}`] : []),
            ].join(', ')}
              from ${table} where ${ofParent(params, parentId)} for update`,
            params,
          );
          const kept = new Set<string>();
          for (const row of current) {
            const k = quoteKey(row, key);
            const p: Row = {};
            const where = `${ofParent(p, parentId)} and ${keyIs(p, row)}`;
            const next = wanted.get(k);
            if (!next) {
              if (nested.length) await removeNested(row[ROW], db);
              await db.rows(`delete from ${table} where ${where}`, p);
              continue;
            }
            kept.add(k);
            const columns = columnsOf(next);
            columns.forEach((c, i) => (p[`v${i}`] = next[c] ?? null));
            await db.rows(
              `update ${table} set ${columns
                .map((c, i) => `${c} = :v${i}`)
                .join(', ')} where ${where}`,
              p,
            );
            if (nested.length) await writeNested(row[ROW], next, db);
          }
          for (const [k, row] of wanted)
            if (!kept.has(k)) await insert(db, parentId, row);
        }
      : undefined,
    async remove(parentId, db) {
      if (nested.length)
        for (const rowId of await rowIds(db, parentId))
          await removeNested(rowId, db);
      const params: Row = {};
      await db.rows(
        `delete from ${table} where ${ofParent(params, parentId)}`,
        params,
      );
    },
  };
}
