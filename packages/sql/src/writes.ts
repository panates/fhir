/**
 * What writes need besides SQL: helpers for a table's `row()`, and the
 * check that a written resource reads back with every element it was given.
 */
import { FhirServerError } from '@fhirjs/server';

/** Runs SQL on the connection of the write, inside its transaction */
export interface SqlRunner {
  rows(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, any>[]>;
}

/**
 * Refuses (422) a resource with a top-level element the table does not keep:
 * the first check of `row()`. `resourceType`, `id` and `meta` are always
 * allowed; a primitive's extensions (`_birthDate`) only when listed. The
 * store checks the rest when it reads the row back.
 */
export function onlyElements(
  resource: Record<string, any>,
  kept: readonly string[],
): void {
  const lost = Object.keys(resource).filter(
    k =>
      k !== 'resourceType' && k !== 'id' && k !== 'meta' && !kept.includes(k),
  );
  if (lost.length)
    throw new FhirServerError(
      422,
      `The ${resource.resourceType} has elements the table has no column for: ${lost
        .map(k => `${resource.resourceType}.${k}`)
        .join(', ')}`,
      'not-supported',
    );
}

/**
 * The id a reference gives for a type: `Patient/3` → '3'; undefined
 * without a reference. Refuses (422) a reference to another type, or one
 * that is not `Type/id` (an absolute URL, a contained resource).
 */
export function referenceId(
  ref: { reference?: string } | undefined,
  type: string,
): string | undefined {
  if (ref?.reference === undefined) return;
  const m = /^([A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})$/.exec(ref.reference);
  if (!m || m[1] !== type)
    throw new FhirServerError(
      422,
      `The reference ${ref.reference} is not to a ${type} of this server`,
      'not-supported',
    );
  return m[2];
}

/**
 * The value of a decimal element for a numeric column: its text when the
 * resource keeps one (1.50), its number otherwise
 */
export function decimalValue(value: unknown): number | string | undefined {
  if (value === undefined || value === null) return;
  return isRaw(value) ? (value as any).rawJSON : (value as number);
}

export function notKept(type: string, paths: string[]): FhirServerError {
  return new FhirServerError(
    422,
    `The ${type} has elements the database does not keep: ${paths.join(', ')}`,
    'not-supported',
  );
}

/**
 * The elements of the written resource that the resource read back does
 * not have, as paths (`Patient.photo`, `Patient.telecom[2]`). Instants are
 * compared as times and decimals as numbers; an array's items in any order;
 * the read resource may have more. `meta.versionId` and `meta.lastUpdated`
 * are the store's.
 */
export function lostElements(
  written: Record<string, any>,
  read: Record<string, any>,
): string[] {
  const { meta, ...rest } = written;
  const w: Record<string, any> = rest;
  if (meta) {
    const { versionId: _v, lastUpdated: _l, ...others } = meta;
    if (Object.keys(others).length) w.meta = others;
  }
  const lost: string[] = [];
  objectLost(w, read, written.resourceType, lost);
  return lost;
}

function objectLost(
  w: Record<string, any>,
  r: unknown,
  path: string,
  lost: string[],
): void {
  for (const [k, v] of Object.entries(w)) {
    const p = `${path}.${k}`;
    const there =
      r && typeof r === 'object' ? (r as Record<string, any>)[k] : undefined;
    if (there === undefined) lost.push(p);
    else if (Array.isArray(v)) {
      if (!Array.isArray(there)) {
        lost.push(p);
        continue;
      }
      const used = new Set<number>();
      v.forEach((item, i) => {
        const j = there.findIndex((x, n) => !used.has(n) && contains(item, x));
        if (j < 0) lost.push(`${p}[${i}]`);
        else used.add(j);
      });
    } else if (!contains(v, there)) {
      if (isObject(v) && isObject(there)) objectLost(v, there, p, lost);
      else lost.push(p);
    }
  }
}

/** w's elements are all in r */
function contains(w: unknown, r: unknown): boolean {
  if (isObject(w)) {
    if (!isObject(r)) return false;
    const lost: string[] = [];
    objectLost(w, r, '', lost);
    return !lost.length;
  }
  if (Array.isArray(w)) {
    if (!Array.isArray(r)) return false;
    const lost: string[] = [];
    objectLost({ a: w }, { a: r }, '', lost);
    return !lost.length;
  }
  return samePrimitive(w, r);
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function samePrimitive(w: unknown, r: unknown): boolean {
  if (isRaw(w)) w = Number((w as any).rawJSON);
  if (isRaw(r)) r = Number((r as any).rawJSON);
  if (w === r) return true;
  if (
    typeof w === 'string' &&
    typeof r === 'string' &&
    DATE_TIME.test(w) &&
    DATE_TIME.test(r)
  ) {
    const a = Date.parse(w);
    return !Number.isNaN(a) && a === Date.parse(r);
  }
  return false;
}

const isRaw = (v: unknown) =>
  typeof (JSON as any).isRawJSON === 'function' && (JSON as any).isRawJSON(v);

const isObject = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !isRaw(v);
