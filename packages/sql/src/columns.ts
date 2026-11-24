/**
 * Search parameters over the columns of a row, by the kind of column behind
 * them: a token over code columns, a string over text columns, a date over
 * an instant, a day or a period, a number, a quantity of a number and a
 * unit, a reference over a foreign key. Each matches as the memory store
 * does (`search-match.ts` of `@fhirjs/server`).
 *
 * A condition of a parameter that takes :not is TRUE or FALSE, never NULL:
 * a value is checked to be there before it is compared, so that NOT keeps
 * the rows that have no value, as FHIR asks.
 */
import {
  FhirServerError,
  type SearchCriterion,
  type SearchValue,
} from '@fhirjs/server';
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
  type Serializable,
} from '@sqb/builder';
import type { SqlDialect } from './dialect.js';

/** An sqb condition */
export type Cond = Serializable;

export const TRUE = Raw('true') as unknown as Cond;
export const FALSE = Raw('false') as unknown as Cond;

/**
 * A column of a row: its name, or an SQL expression of the row's alias
 * (`a => \`(select t.name from tests t where t.code = ${a}.code)\``)
 */
export type Column = string | ((alias: string) => string);

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

/** Where a parameter is translated: the row's alias, the query's parameters, the dialect */
export interface SqlContext {
  alias: string;
  params: SqlParams;
  dialect: SqlDialect;
}

/** How a search parameter is answered from the columns of a row */
export interface ParamSql {
  /** The row has a value for the parameter (:missing=false) */
  present(ctx: SqlContext): Cond;
  /** The condition of one value, without :not and :missing */
  value(ctx: SqlContext, v: SearchValue, modifier: string | undefined): Cond;
  /** The key to sort by: the row's lowest value ascending, its highest descending; none when it cannot be sorted by */
  sort?(ctx: SqlContext, descending: boolean): string;
  /** A reference: the foreign key and the type it refers to, for chains and _has */
  reference?: { fk: Column; target: string };
  /** A composite: answered from its components' parameters on one row */
  composite?: true;
}

/** A parameter answered by code of its own: the whole criterion, :missing and :not included */
export type CustomParam = (ctx: SqlContext, criterion: SearchCriterion) => Cond;

/** The SQL of a column on the row of `alias` */
export function columnSql(column: Column, alias: string): string {
  return typeof column === 'function' ? column(alias) : `${alias}.${column}`;
}

const raw = (sql: string) => Raw(sql);
const has = (expr: string) => IsNot(raw(expr), null);
const or = (conds: Cond[]) =>
  conds.length === 0 ? FALSE : conds.length === 1 ? conds[0] : Or(...conds);
const and = (conds: Cond[]) =>
  conds.length === 0 ? TRUE : conds.length === 1 ? conds[0] : And(...conds);

function refuse(what: string): never {
  throw new FhirServerError(400, `${what} is not supported`, 'not-supported');
}

/* ------------------------------------------------------------------ */
/* Tokens                                                             */
/* ------------------------------------------------------------------ */

/** A code of a token: its system (none for a primitive code), and where it is */
export interface Coding {
  system?: string;
  /** The column it is in; none for a constant */
  column?: Column;
  /** The database's codes to FHIR's (M to male) */
  map?: Record<string, string>;
  /** The code every row has, for a constant */
  constant?: string;
}

/** A code column, its values mapped to FHIR codes when `map` is given */
export function code(
  column: Column,
  options: { system?: string; map?: Record<string, string> } = {},
): Coding {
  return { column, ...options };
}

/** A code every row has (the category `laboratory` of a lab result) */
export function constant(
  value: string,
  options: { system?: string } = {},
): Coding {
  return { constant: value, system: options.system };
}

/** The condition that a coding has a code, and the condition on its code */
function codingSql(c: Coding, ctx: SqlContext) {
  if (c.column === undefined)
    return {
      present: TRUE,
      code: (value: string) => (value === c.constant ? TRUE : FALSE),
    };
  const expr = columnSql(c.column, ctx.alias);
  return {
    present: has(expr),
    code: (value: string) => {
      if (!c.map) return and([has(expr), Eq(raw(expr), ctx.params.add(value))]);
      const keys = Object.keys(c.map).filter(k => c.map![k] === value);
      return keys.length
        ? and([has(expr), or(keys.map(k => Eq(raw(expr), ctx.params.add(k))))])
        : FALSE;
    },
    /** The FHIR code of the row, as text */
    fhir: c.map
      ? `case ${expr} ${Object.entries(c.map)
          .map(
            ([k, v]) =>
              `when '${k.replace(/'/g, "''")}' then '${v.replace(/'/g, "''")}'`,
          )
          .join(' ')} end`
      : ctx.dialect.text(expr),
  };
}

/** A token over codes: system|code, |code, code, system| */
export function token(...codings: Coding[]): ParamSql {
  const sameColumn = (a: Coding, b: Coding) =>
    a.column === b.column &&
    JSON.stringify(a.map ?? null) === JSON.stringify(b.map ?? null);
  return {
    present(ctx) {
      if (codings.some(c => c.column === undefined)) return TRUE;
      // one test per column: a phone with and without its system is one column
      const columns = new Set(
        codings.map(c => columnSql(c.column!, ctx.alias)),
      );
      return or([...columns].map(has));
    },
    value(ctx, v, modifier) {
      if (modifier === 'text') refuse(':text');
      if (modifier !== undefined && modifier !== 'not')
        refuse(`:${modifier} of a token`);
      return or(
        codings.map(c => {
          if (v.system === undefined && v.code === undefined) return FALSE;
          if (v.system === '' && c.system !== undefined) return FALSE;
          if (v.system && c.system !== v.system) return FALSE;
          const sql = codingSql(c, ctx);
          return v.code === undefined ? sql.present : sql.code(v.code);
        }),
      );
    },
    // one code column (its codes may be listed twice, with and without a system)
    sort:
      codings.length > 0 &&
      codings.every(c => c.column !== undefined && sameColumn(c, codings[0]))
        ? ctx => ctx.dialect.binary((codingSql(codings[0], ctx) as any).fhir)
        : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Strings                                                            */
/* ------------------------------------------------------------------ */

/** Case and accents removed, as the memory store's normalize() */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i');
}

const likeEscaped = (s: string) => s.replace(/[\\%_]/g, c => '\\' + c);

/** A string over text columns: starts with, :exact, :contains; case and accents ignored */
export function string(...columns: Column[]): ParamSql {
  return {
    present: ctx => or(columns.map(c => has(columnSql(c, ctx.alias)))),
    value(ctx, v, modifier) {
      if (
        modifier !== undefined &&
        modifier !== 'exact' &&
        modifier !== 'contains'
      )
        refuse(`:${modifier} of a string`);
      return or(
        columns.map(column => {
          const e = columnSql(column, ctx.alias);
          if (modifier === 'exact')
            return and([has(e), Eq(raw(e), ctx.params.add(v.raw))]);
          const text = likeEscaped(normalize(v.raw));
          return and([
            has(e),
            Like(
              raw(ctx.dialect.normalize(e)),
              ctx.params.add(
                modifier === 'contains' ? `%${text}%` : `${text}%`,
              ),
            ),
          ]);
        }),
      );
    },
    // over several columns, the key is the lowest or highest of them: name it yourself
    sort:
      columns.length === 1
        ? ctx =>
            ctx.dialect.binary(
              ctx.dialect.normalize(columnSql(columns[0], ctx.alias)),
            )
        : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Dates                                                              */
/* ------------------------------------------------------------------ */

/** The range a row covers, [lo, hi), as SQL */
export interface DateSql {
  /** The start of the range, the earliest instant where it is open */
  lo: string;
  /** The end of the range, the latest instant where it is open */
  hi: string;
  present: Cond;
  /** The earliest and the latest instant it has, null when it has none */
  first: string;
  last: string;
}

/** A column of instants (timestamptz), to the millisecond */
export const instant =
  (column: Column) =>
  (ctx: SqlContext): DateSql => {
    const e = columnSql(column, ctx.alias);
    const lo = ctx.dialect.instant(e);
    const hi = ctx.dialect.plus(lo, 1, 'millisecond');
    return { lo, hi, present: has(e), first: lo, last: hi };
  };

/** A column of dates: the day, in UTC */
export const day =
  (column: Column) =>
  (ctx: SqlContext): DateSql => {
    const e = columnSql(column, ctx.alias);
    const lo = ctx.dialect.dayStart(e);
    const hi = ctx.dialect.plus(lo, 1, 'day');
    return { lo, hi, present: has(e), first: lo, last: hi };
  };

/** A period of two instant columns, either open */
export const period =
  (start: Column, end: Column) =>
  (ctx: SqlContext): DateSql => {
    const { dialect: d } = ctx;
    const s = columnSql(start, ctx.alias);
    const e = columnSql(end, ctx.alias);
    const first = d.instant(s);
    const last = d.plus(d.instant(e), 1, 'millisecond');
    return {
      lo: `coalesce(${first}, ${d.minInstant})`,
      hi: `coalesce(${last}, ${d.maxInstant})`,
      present: or([has(s), has(e)]),
      first: `coalesce(${first}, ${last})`,
      last: `coalesce(${last}, ${first})`,
    };
  };

/** A date parameter over a range: an instant, a day or a period */
export function date(range: (ctx: SqlContext) => DateSql): ParamSql {
  return {
    present: ctx => range(ctx).present,
    value(ctx, v) {
      const d = range(ctx);
      const lo = raw(d.lo);
      const hi = raw(d.hi);
      const s1 = () => ctx.params.add(new Date(v.start!));
      const s2 = () => ctx.params.add(new Date(v.end!));
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
    sort: (ctx, descending) => {
      const d = range(ctx);
      return descending ? d.last : d.first;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Numbers and quantities                                             */
/* ------------------------------------------------------------------ */

/** A number against a value: eq and ne by its precision, the others by the number */
function numberCond(x: Cond, v: SearchValue, p: SqlParams): Cond {
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

/** A number parameter over a numeric column */
export function number(column: Column): ParamSql & { column: Column } {
  const expr = (ctx: SqlContext) =>
    ctx.dialect.double(columnSql(column, ctx.alias));
  return {
    column,
    present: ctx => has(columnSql(column, ctx.alias)),
    // a number takes no :not: a row without one is NULL, which is not a match
    value: (ctx, v) => numberCond(raw(expr(ctx)), v, ctx.params),
    sort: ctx => expr(ctx),
  };
}

/** A quantity of a number column and a unit: a code column, or a constant */
export function quantity(
  value: ParamSql & { column: Column },
  unit: Coding,
): ParamSql {
  return {
    present: ctx => value.present(ctx),
    value(ctx, v) {
      if (v.system && v.system !== unit.system) return FALSE;
      const u = codingSql(unit, ctx);
      const conds = [value.value(ctx, v, undefined)];
      if (v.code !== undefined) conds.push(u.code(v.code));
      else if (v.system) conds.push(u.present);
      return and(conds);
    },
    sort: value.sort,
  };
}

/* ------------------------------------------------------------------ */
/* References and composites                                          */
/* ------------------------------------------------------------------ */

/**
 * A reference over a foreign key to the table of `target`. An absolute URL
 * reaches the store only for another server (the server gives its own as a
 * type and id), and is not found.
 */
export function reference(fk: Column, target: string): ParamSql {
  return {
    reference: { fk, target },
    present: ctx => has(columnSql(fk, ctx.alias)),
    value(ctx, v) {
      if (v.url || v.id === undefined) return FALSE;
      if (v.type && v.type !== target) return FALSE;
      const e = columnSql(fk, ctx.alias);
      return and([has(e), Eq(raw(ctx.dialect.text(e)), ctx.params.add(v.id))]);
    },
    sort: ctx =>
      ctx.dialect.binary(
        `'${target}/' || ${ctx.dialect.text(columnSql(fk, ctx.alias))}`,
      ),
  };
}

/**
 * A composite whose parts are on one row (`code-value-quantity` of a lab
 * result): each value matches when every part matches on the row, and the
 * row has it when it has every part. The parts are the table's parameters
 * of the composite's components.
 */
export function composite(): ParamSql {
  return {
    composite: true,
    present: () => FALSE,
    value: () => FALSE,
  };
}
