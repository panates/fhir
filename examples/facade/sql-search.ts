/**
 * Search criteria as sqb conditions, by the kind of column behind a
 * parameter: a token over code columns, a string over text columns, a date
 * over an instant, a date or a period, a quantity over a number and a unit,
 * a reference over a foreign key. These are what a SQL helper for facades
 * would take over; each matches as the memory store does (search-match.ts).
 *
 * A condition of a parameter that takes :not is TRUE or FALSE, never NULL:
 * a value is checked to be there before it is compared, so that NOT keeps
 * the rows that have no value, as FHIR asks.
 */
import {
  And,
  Eq,
  Gt,
  Gte,
  IsNot,
  Like,
  Lt,
  Lte,
  Not,
  Or,
  Param,
  Raw,
} from '@sqb/builder';
import { FhirServerError, type SearchValue } from '@fhirjs/server';
import type { Serializable } from '@sqb/builder';

/** A sqb condition */
export type Cond = Serializable;

export const TRUE = Raw('true') as unknown as Cond;
export const FALSE = Raw('false') as unknown as Cond;

/** The parameters of a query, named p0, p1, ... */
export class SqlParams {
  readonly values: Record<string, unknown> = {};
  private _n = 0;

  add(value: unknown) {
    const name = `p${this._n++}`;
    this.values[name] = value;
    return Param(name);
  }
}

/** How one search parameter is answered from the columns of a row */
export interface ParamSql {
  /** The condition of one value, without :not and :missing */
  value(v: SearchValue, modifier: string | undefined, p: SqlParams): Cond;
  /**
   * The row has a value for the parameter (:missing). Undefined where it
   * would be an OR of two IS NOT NULL, which sqb 6.3.6 cannot run: with
   * strictParams it adds a parameter the SQL does not use (reported).
   */
  present?: Cond;
}

const raw = (sql: string) => Raw(sql);
const has = (expr: string) => IsNot(raw(expr), null);
const or = (conds: Cond[]) =>
  conds.length === 0 ? FALSE : conds.length === 1 ? conds[0] : Or(...conds);
const and = (conds: Cond[]) => (conds.length === 1 ? conds[0] : And(...conds));

function refuse(what: string): never {
  throw new FhirServerError(400, `${what} is not supported`, 'not-supported');
}

/* ------------------------------------------------------------------ */
/* Tokens                                                             */
/* ------------------------------------------------------------------ */

/** A code of a token: its system (none for a primitive code) and the condition on its code */
export interface Coding {
  system?: string;
  code(code: string, p: SqlParams): Cond;
  present: Cond;
  /** The column it is in; none for a constant */
  column?: string;
}

/** A code column, its values mapped to FHIR codes when `map` is given (M to male) */
export function codeColumn(
  expr: string,
  system?: string,
  map?: Record<string, string>,
): Coding {
  return {
    system,
    column: expr,
    present: has(expr),
    code: (code, p) => {
      if (!map) return and([has(expr), Eq(raw(expr), p.add(code))]);
      const keys = Object.keys(map).filter(k => map[k] === code);
      return keys.length
        ? and([has(expr), or(keys.map(k => Eq(raw(expr), p.add(k))))])
        : FALSE;
    },
  };
}

/** A code every row has (category laboratory) */
export function constantCode(code: string, system?: string): Coding {
  return {
    system,
    present: TRUE,
    code: c => (c === code ? TRUE : FALSE),
  };
}

/** A token over codes: system|code, |code, code, system| */
export function token(...codings: Coding[]): ParamSql {
  const columns = new Set(codings.map(c => c.column));
  return {
    present: columns.has(undefined)
      ? TRUE
      : columns.size === 1
        ? codings[0].present
        : undefined,
    value(v, modifier, p) {
      if (modifier === 'text') refuse(':text');
      return or(
        codings.map(c => {
          if (v.system === undefined && v.code === undefined) return FALSE;
          if (v.system === '' && c.system !== undefined) return FALSE;
          if (v.system && c.system !== v.system) return FALSE;
          return v.code === undefined ? c.present : c.code(v.code, p);
        }),
      );
    },
  };
}

/* ------------------------------------------------------------------ */
/* Strings                                                            */
/* ------------------------------------------------------------------ */

/** Case and accents removed, as the memory store's normalize() */
export const normalizeSql = (expr: string) =>
  `translate(lower(public.unaccent(${expr})), 'ı', 'i')`;

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i');
}

const likeEscaped = (s: string) => s.replace(/[\\%_]/g, c => '\\' + c);

/** A string over text columns: starts with, :exact, :contains; case and accents ignored */
export function strings(...exprs: string[]): ParamSql {
  return {
    present: exprs.length === 1 ? has(exprs[0]) : undefined,
    value(v, modifier, p) {
      return or(
        exprs.map(e => {
          if (modifier === 'exact')
            return and([has(e), Eq(raw(e), p.add(v.raw))]);
          const text = likeEscaped(normalize(v.raw));
          return and([
            has(e),
            Like(
              raw(normalizeSql(e)),
              p.add(modifier === 'contains' ? `%${text}%` : `${text}%`),
            ),
          ]);
        }),
      );
    },
  };
}

/* ------------------------------------------------------------------ */
/* Dates                                                              */
/* ------------------------------------------------------------------ */

/** The range a row covers, [lo, hi), as SQL, and whether it has one */
export interface DateSql {
  lo: string;
  hi: string;
  present: Cond;
}

/** An instant column, to the millisecond FHIR writes */
export function instantColumn(expr: string): DateSql {
  const lo = `date_trunc('milliseconds', ${expr})`;
  return { lo, hi: `(${lo} + interval '1 millisecond')`, present: has(expr) };
}

/** A date column: the day, in UTC */
export function dateColumn(expr: string): DateSql {
  const lo = `(cast(${expr} as timestamp) at time zone 'UTC')`;
  return { lo, hi: `(${lo} + interval '1 day')`, present: has(expr) };
}

/**
 * A period of two instant columns, either open. Not used yet: whether it has
 * a range is an OR of two IS NOT NULL, which sqb 6.3.6 cannot run.
 */
export function periodColumns(start: string, end: string): DateSql {
  return {
    lo: `coalesce(date_trunc('milliseconds', ${start}), cast('-infinity' as timestamptz))`,
    hi: `coalesce(date_trunc('milliseconds', ${end}) + interval '1 millisecond', cast('infinity' as timestamptz))`,
    present: or([has(start), has(end)]),
  };
}

/** A date against a range, with its prefix */
export function date(d: DateSql): ParamSql {
  return {
    present: d.present,
    value(v, _modifier, p) {
      const lo = raw(d.lo);
      const hi = raw(d.hi);
      const s1 = () => p.add(new Date(v.start!));
      const s2 = () => p.add(new Date(v.end!));
      const eq = () => and([Gte(lo, s1()), Lte(hi, s2())]);
      let c: Cond;
      switch (v.prefix ?? 'eq') {
        case 'eq':
          c = eq();
          break;
        case 'ne':
          c = Not(eq());
          break;
        case 'gt':
          c = Gt(hi, s2());
          break;
        case 'lt':
          c = Lt(lo, s1());
          break;
        case 'ge':
          c = or([Gt(hi, s2()), eq()]);
          break;
        case 'le':
          c = or([Lt(lo, s1()), eq()]);
          break;
        case 'sa':
          c = Gte(lo, s2());
          break;
        case 'eb':
          c = Lte(hi, s1());
          break;
        default:
          refuse(`The prefix ${v.prefix} of a date`);
      }
      return and([d.present, c]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Numbers and quantities                                             */
/* ------------------------------------------------------------------ */

/** A number against a value: eq and ne by its precision, the others by the number */
function numberCond(n: string, v: SearchValue, p: SqlParams): Cond {
  const x = raw(n);
  const eq = () => and([Gte(x, p.add(v.start!)), Lt(x, p.add(v.end!))]);
  switch (v.prefix ?? 'eq') {
    case 'eq':
      return eq();
    case 'ne':
      return Not(eq());
    case 'gt':
    case 'sa':
      return Gt(x, p.add(v.number!));
    case 'lt':
    case 'eb':
      return Lt(x, p.add(v.number!));
    case 'ge':
      return or([Gte(x, p.add(v.number!)), eq()]);
    case 'le':
      return or([Lte(x, p.add(v.number!)), eq()]);
    case 'ap': {
      const d = Math.abs(v.number!) * 0.1;
      return and([Gte(x, p.add(v.number! - d)), Lte(x, p.add(v.number! + d))]);
    }
  }
  return FALSE;
}

/** A quantity of a number column and a unit column, the unit a code of `system` (UCUM) */
export function quantity(
  value: string,
  unit: string,
  system: string,
): ParamSql {
  return {
    present: has(value),
    // a number takes no :not: a row without one is NULL, which is not a match
    value(v, _modifier, p) {
      const conds = [numberCond(value, v, p)];
      if (v.system && v.system !== system) return FALSE;
      if (v.code !== undefined) conds.push(Eq(raw(unit), p.add(v.code)));
      else if (v.system) conds.push(has(unit));
      return and(conds);
    },
  };
}

/* ------------------------------------------------------------------ */
/* References                                                         */
/* ------------------------------------------------------------------ */

/**
 * A reference over a foreign key to a type's table. An absolute URL is not
 * found: the store does not know the server's base URL, to tell its own
 * references from others.
 */
export function reference(fk: string, target: string): ParamSql {
  return {
    present: has(fk),
    value(v, _modifier, p) {
      if (v.url || v.id === undefined) return FALSE;
      if (v.type && v.type !== target) return FALSE;
      return and([has(fk), Eq(raw(`cast(${fk} as text)`), p.add(v.id))]);
    },
  };
}
