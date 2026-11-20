import {
  bool,
  checkTypeName,
  childrenOf,
  EMPTY,
  type EvalContext,
  FALSE,
  type Fn,
  isOfType,
  isSystemVariable,
  navigate,
  toBool,
  TRUE,
  union,
  withScope,
} from './evaluate.js';
import {
  FhirPathError,
  FpQuantity,
  FpTemporal,
  Item,
  itemCompare,
  itemEquals,
  primitiveValue,
  quantityOf,
  quantityPair,
  decimalText,
  systemType,
  typeLabel,
} from './values.js';

export interface FunctionImpl {
  /** Allowed argument counts: [min, max] */
  arity?: [number, number];
  /** The argument is a type name (ofType(Patient)), not an expression */
  typeArg?: boolean;
  fn(ctx: EvalContext, input: Item[], args: Fn[], typeName?: string): Item[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** The context for an argument evaluated on one item: $this, $index */
const on = (ctx: EvalContext, item: Item, index: number): EvalContext => ({
  ...ctx,
  focus: [item],
  index,
});

/** A single-valued argument (evaluated in the caller's context) */
function arg(
  ctx: EvalContext,
  fn: Fn | undefined,
  name: string,
): Item | undefined {
  if (!fn) return;
  const items = fn(ctx);
  if (items.length > 1)
    throw new FhirPathError(`The argument of ${name}() must be a single item`);
  return items[0];
}

function argString(
  ctx: EvalContext,
  fn: Fn | undefined,
  name: string,
): string | undefined {
  const a = arg(ctx, fn, name);
  if (!a) return;
  if (typeof a.v !== 'string')
    throw new FhirPathError(`The argument of ${name}() must be a String`);
  return a.v;
}

function argInteger(
  ctx: EvalContext,
  fn: Fn | undefined,
  name: string,
): number | undefined {
  const a = arg(ctx, fn, name);
  if (!a) return;
  if (typeof a.v !== 'number' || !Number.isInteger(a.v))
    throw new FhirPathError(`The argument of ${name}() must be an Integer`);
  return a.v;
}

/** The input as a single String, or undefined when empty */
function inputString(input: Item[], name: string): string | undefined {
  if (!input.length) return;
  if (input.length > 1)
    throw new FhirPathError(
      `${name}() expects a single item, got ${input.length}`,
    );
  const v = input[0].v;
  // a primitive with only extensions has no value
  if (v === null || v === undefined) return;
  if (typeof v !== 'string')
    throw new FhirPathError(
      `${name}() expects a String, got ${typeLabel(input[0])}`,
    );
  return v;
}

const str = (s: string) => [new Item(s, 'System.String')];
const int = (n: number) => [new Item(n, 'System.Integer')];

/** A FHIR regex as JavaScript takes it: s (dot takes newlines), not u */
const regexCache = new Map<string, RegExp>();
function regex(source: string, flags = 's'): RegExp {
  const key = flags + '\u0000' + source;
  let re = regexCache.get(key);
  if (!re) {
    try {
      re = new RegExp(source, flags);
    } catch (e) {
      throw new FhirPathError(
        `Invalid regular expression ${source}: ${(e as Error).message}`,
      );
    }
    regexCache.set(key, re);
  }
  return re;
}

/** Items without duplicates (by =) */
/**
 * The items without repeats, the last of each kept (as the R5 suite has it);
 * undefined when two items cannot be compared (@2020 and @2020-01-01)
 */
function distinctOrUndefined(items: Item[]): Item[] | undefined {
  const out: Item[] = [];
  for (let k = 0; k < items.length; k++) {
    let repeated = false;
    for (let j = k + 1; j < items.length && !repeated; j++) {
      const eq = itemEquals(items[k], items[j]);
      if (eq === undefined && comparableKinds(items[k], items[j]))
        return undefined;
      repeated = eq === true;
    }
    if (!repeated) out.push(items[k]);
  }
  return out;
}

/** Two dates or times, which equality can leave undecided by their precision */
const comparableKinds = (a: Item, b: Item) =>
  primitiveValue(a) instanceof FpTemporal &&
  primitiveValue(b) instanceof FpTemporal;

const distinct = (items: Item[]): Item[] => distinctOrUndefined(items) ?? EMPTY;

function boolsOf(input: Item[], name: string): boolean[] {
  return input.map(i => {
    if (typeof i.v !== 'boolean')
      throw new FhirPathError(
        `${name}() expects Booleans, got ${typeLabel(i)}`,
      );
    return i.v;
  });
}

function where(ctx: EvalContext, input: Item[], criteria: Fn): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < input.length; i++)
    if (toBool(criteria(on(ctx, input[i], i)), 'where') === true)
      out.push(input[i]);
  return out;
}

function numberOf(
  input: Item[],
  name: string,
): { v: number; t: string } | undefined {
  if (!input.length) return;
  if (input.length > 1)
    throw new FhirPathError(`${name}() expects a single item`);
  const v = primitiveValue(input[0]);
  if (typeof v !== 'number')
    throw new FhirPathError(
      `${name}() expects a number, got ${typeLabel(input[0])}`,
    );
  return {
    v,
    t: systemType(input[0]) === 'Integer' ? 'System.Integer' : 'System.Decimal',
  };
}

const math = (f: (x: number) => number, decimal = true): FunctionImpl => ({
  arity: [0, 0],
  fn: (_ctx, input) => {
    // abs(), ceiling() ... of a quantity keep its unit
    if (input.length === 1 && !decimal && input[0].v instanceof FpQuantity) {
      const q = input[0].v as FpQuantity;
      return [new Item(new FpQuantity(f(q.value), q.unit), 'System.Quantity')];
    }
    const n = numberOf(input, 'math');
    if (!n) return EMPTY;
    const r = f(n.v);
    return Number.isFinite(r)
      ? [new Item(r, decimal ? 'System.Decimal' : n.t)]
      : EMPTY;
  },
});

/** The number of decimal places a value is written with */
function decimalPlaces(item: Item): number {
  const text = decimalText(item) ?? String(item.v);
  const i = text.indexOf('.');
  return i < 0 ? 0 : text.length - i - 1;
}

/* ------------------------------------------------------------------ */
/* The functions                                                      */
/* ------------------------------------------------------------------ */

export const FUNCTIONS: Record<string, FunctionImpl> = {
  /* Existence */
  empty: { arity: [0, 0], fn: (_c, input) => bool(!input.length) },
  exists: {
    arity: [0, 1],
    fn: (ctx, input, [criteria]) =>
      bool(
        criteria ? where(ctx, input, criteria).length > 0 : input.length > 0,
      ),
  },
  all: {
    arity: [1, 1],
    fn: (ctx, input, [criteria]) => {
      for (let i = 0; i < input.length; i++)
        if (toBool(criteria(on(ctx, input[i], i)), 'all') !== true)
          return FALSE;
      return TRUE;
    },
  },
  allTrue: {
    arity: [0, 0],
    fn: (_c, input) => bool(boolsOf(input, 'allTrue').every(b => b)),
  },
  anyTrue: {
    arity: [0, 0],
    fn: (_c, input) => bool(boolsOf(input, 'anyTrue').some(b => b)),
  },
  allFalse: {
    arity: [0, 0],
    fn: (_c, input) => bool(boolsOf(input, 'allFalse').every(b => !b)),
  },
  anyFalse: {
    arity: [0, 0],
    fn: (_c, input) => bool(boolsOf(input, 'anyFalse').some(b => !b)),
  },
  subsetOf: {
    arity: [1, 1],
    fn: (ctx, input, [other]) => {
      const o = other(ctx);
      return bool(input.every(i => o.some(x => itemEquals(i, x) === true)));
    },
  },
  supersetOf: {
    arity: [1, 1],
    fn: (ctx, input, [other]) =>
      bool(other(ctx).every(x => input.some(i => itemEquals(i, x) === true))),
  },
  count: { arity: [0, 0], fn: (_c, input) => int(input.length) },
  distinct: { arity: [0, 0], fn: (_c, input) => distinct(input) },
  isDistinct: {
    arity: [0, 0],
    fn: (_c, input) => {
      const d = distinctOrUndefined(input);
      return d ? bool(d.length === input.length) : EMPTY;
    },
  },

  /* Filtering and projection */
  where: {
    arity: [1, 1],
    fn: (ctx, input, [criteria]) => where(ctx, input, criteria),
  },
  select: {
    arity: [1, 1],
    fn: (ctx, input, [projection]) => {
      const out: Item[] = [];
      for (let i = 0; i < input.length; i++)
        out.push(...projection(on(ctx, input[i], i)));
      return out;
    },
  },
  repeat: {
    arity: [1, 1],
    fn: (ctx, input, [projection]) => {
      const out: Item[] = [];
      let queue = input;
      while (queue.length) {
        const next: Item[] = [];
        for (let i = 0; i < queue.length; i++)
          for (const r of projection(on(ctx, queue[i], i)))
            if (
              !out.some(
                o => o === r || (o.v === r.v && typeof r.v === 'object'),
              )
            ) {
              out.push(r);
              next.push(r);
            }
        queue = next;
      }
      return out;
    },
  },
  ofType: {
    arity: [1, 1],
    typeArg: true,
    fn: (ctx, input, _a, type) => {
      checkTypeName(ctx.env, type!);
      return input.filter(i => isOfType(ctx.env, i, type!, true));
    },
  },
  is: {
    arity: [1, 1],
    typeArg: true,
    fn: (ctx, input, _a, type) => {
      checkTypeName(ctx.env, type!);
      if (!input.length) return EMPTY;
      if (input.length > 1)
        throw new FhirPathError(
          `is() expects a single item, got ${input.length}`,
        );
      return bool(isOfType(ctx.env, input[0], type!));
    },
  },
  as: {
    arity: [1, 1],
    typeArg: true,
    fn: (ctx, input, _a, type) => {
      checkTypeName(ctx.env, type!);
      if (input.length > 1 && !ctx.env.lenient)
        throw new FhirPathError(`as() on ${input.length} items`);
      return input.filter(i => isOfType(ctx.env, i, type!, true));
    },
  },

  /* Subsetting */
  single: {
    arity: [0, 0],
    fn: (_c, input) => {
      if (input.length > 1)
        throw new FhirPathError(`single() on ${input.length} items`);
      return input;
    },
  },
  first: { arity: [0, 0], fn: (_c, input) => input.slice(0, 1) },
  last: { arity: [0, 0], fn: (_c, input) => input.slice(-1) },
  tail: { arity: [0, 0], fn: (_c, input) => input.slice(1) },
  skip: {
    arity: [1, 1],
    fn: (ctx, input, [n]) => {
      const k = argInteger(ctx, n, 'skip');
      return k === undefined ? EMPTY : input.slice(Math.max(0, k));
    },
  },
  take: {
    arity: [1, 1],
    fn: (ctx, input, [n]) => {
      const k = argInteger(ctx, n, 'take');
      return k === undefined ? EMPTY : input.slice(0, Math.max(0, k));
    },
  },
  intersect: {
    arity: [1, 1],
    fn: (ctx, input, [other]) => {
      const o = other(ctx);
      return distinct(
        input.filter(i => o.some(x => itemEquals(i, x) === true)),
      );
    },
  },
  exclude: {
    arity: [1, 1],
    fn: (ctx, input, [other]) => {
      const o = other(ctx);
      return input.filter(i => !o.some(x => itemEquals(i, x) === true));
    },
  },
  union: {
    arity: [1, 1],
    fn: (ctx, input, [other]) => union(input, other(ctx)),
  },
  combine: {
    arity: [1, 1],
    fn: (ctx, input, [other]) => [...input, ...other(ctx)],
  },

  /* Conversion */
  iif: {
    arity: [2, 3],
    fn: (ctx, input, [criterion, whenTrue, otherwise]) => {
      if (input.length > 1)
        throw new FhirPathError(`iif() on ${input.length} items`);
      const c = { ...ctx, focus: input.length === 1 ? input : ctx.focus };
      const r = criterion(c);
      if (r.length > 1 || (r.length === 1 && typeof r[0].v !== 'boolean'))
        throw new FhirPathError('The criterion of iif() must be a Boolean');
      return r.length && r[0].v === true
        ? whenTrue(c)
        : otherwise
          ? otherwise(c)
          : EMPTY;
    },
  },
  toBoolean: {
    arity: [0, 0],
    fn: (_c, input) => {
      if (input.length !== 1) return EMPTY;
      const v = primitiveValue(input[0]);
      if (typeof v === 'boolean') return bool(v);
      if (typeof v === 'number')
        return v === 1 ? TRUE : v === 0 ? FALSE : EMPTY;
      if (typeof v === 'string') {
        const s = v.toLowerCase();
        if (['true', 't', 'yes', 'y', '1', '1.0'].includes(s)) return TRUE;
        if (['false', 'f', 'no', 'n', '0', '0.0'].includes(s)) return FALSE;
      }
      return EMPTY;
    },
  },
  toInteger: {
    arity: [0, 0],
    fn: (_c, input) => {
      if (input.length !== 1) return EMPTY;
      const v = primitiveValue(input[0]);
      if (typeof v === 'boolean') return int(v ? 1 : 0);
      if (typeof v === 'number' && Number.isInteger(v)) return int(v);
      if (typeof v === 'string' && /^[+-]?\d+$/.test(v)) return int(Number(v));
      return EMPTY;
    },
  },
  toDecimal: {
    arity: [0, 0],
    fn: (_c, input) => {
      if (input.length !== 1) return EMPTY;
      const v = primitiveValue(input[0]);
      if (typeof v === 'boolean')
        return [new Item(v ? 1 : 0, 'System.Decimal')];
      if (typeof v === 'number') return [new Item(v, 'System.Decimal')];
      if (typeof v === 'string' && /^[+-]?\d+(\.\d+)?$/.test(v))
        return [new Item(Number(v), 'System.Decimal', v)];
      return EMPTY;
    },
  },
  toQuantity: {
    arity: [0, 1],
    fn: (ctx, input, [u]) => {
      const q = toQuantity(input);
      if (!q) return EMPTY;
      const unit = argString(ctx, u, 'toQuantity');
      if (unit === undefined || unit === q.unit)
        return [new Item(q, 'System.Quantity')];
      const pair = quantityPair(new FpQuantity(1, unit), q);
      return pair
        ? [new Item(new FpQuantity(pair.b, unit), 'System.Quantity')]
        : EMPTY;
    },
  },
  toDate: { arity: [0, 0], fn: (_c, input) => toTemporal(input, 'Date') },
  toDateTime: {
    arity: [0, 0],
    fn: (_c, input) => toTemporal(input, 'DateTime'),
  },
  toTime: { arity: [0, 0], fn: (_c, input) => toTemporal(input, 'Time') },
  toString: {
    arity: [0, 0] as [number, number],
    fn: (_c, input) => {
      if (input.length !== 1) return EMPTY;
      const i = input[0];
      const v = primitiveValue(i);
      if (v === null || v === undefined) return EMPTY;
      if (typeof v === 'string') return str(v);
      if (typeof v === 'boolean') return str(String(v));
      if (typeof v === 'number') return str(decimalText(i) ?? String(v));
      if (v instanceof FpTemporal || v instanceof FpQuantity)
        return str(String(v));
      return EMPTY;
    },
  },

  /* Strings */
  indexOf: {
    arity: [1, 1],
    fn: (ctx, input, [s]) => {
      const v = inputString(input, 'indexOf');
      const sub = argString(ctx, s, 'indexOf');
      return v === undefined || sub === undefined ? EMPTY : int(v.indexOf(sub));
    },
  },
  substring: {
    arity: [1, 2],
    fn: (ctx, input, [start, length]) => {
      const v = inputString(input, 'substring');
      const s = argInteger(ctx, start, 'substring');
      if (v === undefined || s === undefined || s < 0 || s >= v.length)
        return EMPTY;
      const l = length ? argInteger(ctx, length, 'substring') : undefined;
      return str(l === undefined ? v.slice(s) : v.substr(s, l));
    },
  },
  startsWith: {
    arity: [1, 1],
    fn: (ctx, input, [s]) => {
      const v = inputString(input, 'startsWith');
      const p = argString(ctx, s, 'startsWith');
      return v === undefined || p === undefined ? EMPTY : bool(v.startsWith(p));
    },
  },
  endsWith: {
    arity: [1, 1],
    fn: (ctx, input, [s]) => {
      const v = inputString(input, 'endsWith');
      const p = argString(ctx, s, 'endsWith');
      return v === undefined || p === undefined ? EMPTY : bool(v.endsWith(p));
    },
  },
  contains: {
    arity: [1, 1],
    fn: (ctx, input, [s]) => {
      const v = inputString(input, 'contains');
      const p = argString(ctx, s, 'contains');
      return v === undefined || p === undefined ? EMPTY : bool(v.includes(p));
    },
  },
  upper: {
    arity: [0, 0],
    fn: (_c, input) => {
      const v = inputString(input, 'upper');
      return v === undefined ? EMPTY : str(v.toUpperCase());
    },
  },
  lower: {
    arity: [0, 0],
    fn: (_c, input) => {
      const v = inputString(input, 'lower');
      return v === undefined ? EMPTY : str(v.toLowerCase());
    },
  },
  replace: {
    arity: [2, 2],
    fn: (ctx, input, [p, r]) => {
      const v = inputString(input, 'replace');
      const pattern = argString(ctx, p, 'replace');
      const subst = argString(ctx, r, 'replace');
      if (v === undefined || pattern === undefined || subst === undefined)
        return EMPTY;
      // an empty pattern goes between every character and at both ends
      if (!pattern) return str(subst + [...v].join(subst) + subst);
      return str(v.split(pattern).join(subst));
    },
  },
  matches: {
    arity: [1, 1],
    fn: (ctx, input, [r]) => {
      const v = inputString(input, 'matches');
      const re = argString(ctx, r, 'matches');
      return v === undefined || re === undefined
        ? EMPTY
        : bool(regex(re).test(v));
    },
  },
  matchesFull: {
    arity: [1, 1],
    fn: (ctx, input, [r]) => {
      const v = inputString(input, 'matchesFull');
      const re = argString(ctx, r, 'matchesFull');
      return v === undefined || re === undefined
        ? EMPTY
        : bool(regex(`^(?:${re})$`).test(v));
    },
  },
  replaceMatches: {
    arity: [2, 2],
    fn: (ctx, input, [r, s]) => {
      const v = inputString(input, 'replaceMatches');
      const re = argString(ctx, r, 'replaceMatches');
      const subst = argString(ctx, s, 'replaceMatches');
      if (v === undefined || re === undefined || subst === undefined)
        return EMPTY;
      return str(re ? v.replace(regex(re, 'gs'), subst) : v);
    },
  },
  length: {
    arity: [0, 0],
    fn: (_c, input) => {
      const v = inputString(input, 'length');
      return v === undefined ? EMPTY : int(v.length);
    },
  },
  toChars: {
    arity: [0, 0],
    fn: (_c, input) => {
      const v = inputString(input, 'toChars');
      return v === undefined
        ? EMPTY
        : [...v].map(c => new Item(c, 'System.String'));
    },
  },

  /* Math */
  abs: math(Math.abs, false),
  ceiling: math(Math.ceil, false),
  floor: math(Math.floor, false),
  truncate: math(Math.trunc, false),
  exp: math(Math.exp),
  ln: math(Math.log),
  sqrt: math(Math.sqrt),
  log: {
    arity: [1, 1],
    fn: (ctx, input, [b]) => {
      const n = numberOf(input, 'log');
      const base = arg(ctx, b, 'log');
      return n && typeof base?.v === 'number'
        ? [new Item(Math.log(n.v) / Math.log(base.v), 'System.Decimal')]
        : EMPTY;
    },
  },
  power: {
    arity: [1, 1],
    fn: (ctx, input, [e]) => {
      const n = numberOf(input, 'power');
      const x = arg(ctx, e, 'power');
      if (!n || typeof x?.v !== 'number') return EMPTY;
      const r = Math.pow(n.v, x.v);
      return Number.isFinite(r)
        ? [
            new Item(
              r,
              n.t === 'System.Integer' && systemType(x) === 'Integer'
                ? 'System.Integer'
                : 'System.Decimal',
            ),
          ]
        : EMPTY;
    },
  },
  round: {
    arity: [0, 1],
    fn: (ctx, input, [p]) => {
      const n = numberOf(input, 'round');
      if (!n) return EMPTY;
      const d = p ? (argInteger(ctx, p, 'round') ?? 0) : 0;
      const f = 10 ** d;
      return [new Item(Math.round(n.v * f) / f, 'System.Decimal')];
    },
  },

  /* Tree */
  children: { arity: [0, 0], fn: (ctx, input) => childrenOf(ctx.env, input) },
  descendants: {
    arity: [0, 0],
    fn: (ctx, input) => {
      const out: Item[] = [];
      let level = childrenOf(ctx.env, input);
      while (level.length) {
        out.push(...level);
        level = childrenOf(ctx.env, level);
      }
      return out;
    },
  },

  /* Utility */
  trace: {
    arity: [1, 2],
    fn: (ctx, input, [name, projection]) => {
      if (ctx.env.trace) {
        const label = argString(ctx, name, 'trace') ?? '';
        const shown = projection
          ? input.flatMap((it, i) => projection(on(ctx, it, i)))
          : input;
        ctx.env.trace(
          label,
          shown.map(i => i.v),
        );
      }
      return input;
    },
  },
  now: {
    arity: [0, 0],
    fn: ctx => [
      new Item(
        new FpTemporal('DateTime', ctx.env.now.toISOString()),
        'System.DateTime',
      ),
    ],
  },
  today: {
    arity: [0, 0],
    fn: ctx => [
      new Item(
        new FpTemporal('Date', ctx.env.now.toISOString().slice(0, 10)),
        'System.Date',
      ),
    ],
  },
  timeOfDay: {
    arity: [0, 0],
    fn: ctx => [
      new Item(
        new FpTemporal('Time', ctx.env.now.toISOString().slice(11, 23)),
        'System.Time',
      ),
    ],
  },
  not: {
    arity: [0, 0],
    fn: (_c, input) => {
      const b = toBool(input, 'not');
      return b === undefined ? EMPTY : bool(!b);
    },
  },
  aggregate: {
    arity: [1, 2],
    fn: (ctx, input, [aggregator, init]) => {
      let total = init ? init(ctx) : EMPTY;
      for (let i = 0; i < input.length; i++)
        total = aggregator({ ...ctx, focus: [input[i]], index: i, total });
      return total;
    },
  },

  /* FHIR additions */
  extension: {
    arity: [1, 1],
    fn: (ctx, input, [u]) => {
      const url = argString(ctx, u, 'extension');
      if (url === undefined) return EMPTY;
      return navigate(ctx.env, input, 'extension').filter(
        e => e.v && e.v.url === url,
      );
    },
  },
  hasExtension: {
    arity: [1, 1],
    fn: (ctx, input, [u]) => {
      const url = argString(ctx, u, 'hasExtension');
      return bool(
        navigate(ctx.env, input, 'extension').some(e => e.v && e.v.url === url),
      );
    },
  },
  hasValue: {
    arity: [0, 0],
    fn: (_c, input) =>
      bool(
        input.length === 1 &&
          input[0].v !== null &&
          input[0].v !== undefined &&
          (typeof input[0].v !== 'object' ||
            input[0].v instanceof FpTemporal ||
            input[0].v instanceof FpQuantity),
      ),
  },
  getValue: {
    arity: [0, 0],
    fn: (_c, input) =>
      input.length === 1 &&
      input[0].v !== null &&
      typeof input[0].v !== 'object'
        ? [new Item(input[0].v, input[0].t)]
        : EMPTY,
  },
  resolve: {
    arity: [0, 0],
    fn: (ctx, input) => {
      const out: Item[] = [];
      for (const i of input) {
        const ref =
          typeof i.v === 'string'
            ? i.v
            : i.v && typeof i.v.reference === 'string'
              ? i.v.reference
              : undefined;
        if (!ref) continue;
        const r = resolveReference(ctx, ref);
        if (r && typeof r === 'object')
          out.push(new Item(r, (r as any).resourceType));
      }
      return out;
    },
  },
  memberOf: {
    arity: [1, 1],
    fn: (ctx, input, [vs]) => {
      const url = argString(ctx, vs, 'memberOf');
      if (!input.length || url === undefined || !ctx.env.memberOf) return EMPTY;
      if (input.length > 1)
        throw new FhirPathError('memberOf() expects a single item');
      const r = ctx.env.memberOf(input[0].v, url);
      return r === undefined ? EMPTY : bool(r);
    },
  },
  htmlChecks: {
    // The narrative rules: only the elements FHIR's XHTML allows, no event
    // attributes, a root <div> in the XHTML namespace. Not a full XML parse.
    arity: [0, 0],
    fn: (_c, input) => {
      if (input.length !== 1 || typeof input[0].v !== 'string') return EMPTY;
      const v = input[0].v.trim();
      if (/^<div[\s>]/.test(v) && !v.includes('http://www.w3.org/1999/xhtml'))
        return FALSE;
      for (const m of v.matchAll(/<\/?([A-Za-z][\w:-]*)([^>]*)>/g)) {
        if (!NARRATIVE_ELEMENTS.has(m[1].replace(/^\w+:/, '').toLowerCase()))
          return FALSE;
        if (/\son\w+\s*=/i.test(m[2])) return FALSE;
      }
      return TRUE;
    },
  },
  conformsTo: {
    arity: [1, 1],
    fn: (ctx, input, [u]) => {
      const url = argString(ctx, u, 'conformsTo');
      if (url === undefined || !input.length) return EMPTY;
      if (input.length > 1)
        throw new FhirPathError(
          `conformsTo() expects a single item, got ${input.length}`,
        );
      const own = ctx.env.conformsTo?.(input[0].v, url);
      if (own !== undefined) return bool(own);
      // a core type's StructureDefinition: whether the item is of that type
      const m =
        /^http:\/\/hl7\.org\/fhir\/StructureDefinition\/([A-Za-z]+)$/.exec(url);
      if (m && (!ctx.env.model || ctx.env.model.hasType(m[1])))
        return bool(isOfType(ctx.env, input[0], m[1]));
      throw new FhirPathError(`conformsTo(): unknown profile ${url}`);
    },
  },
  comparable: {
    arity: [1, 1],
    fn: (ctx, input, [other]) => {
      const a = input.length === 1 ? quantityOf(input[0]) : undefined;
      const o = arg(ctx, other, 'comparable');
      const b = o ? quantityOf(o) : undefined;
      return a && b ? bool(!!quantityPair(a, b)) : EMPTY;
    },
  },
  lowBoundary: {
    arity: [0, 1],
    fn: (ctx, input, [p]) => boundary(ctx, input, p, -1),
  },
  highBoundary: {
    arity: [0, 1],
    fn: (ctx, input, [p]) => boundary(ctx, input, p, 1),
  },
  precision: {
    arity: [0, 0],
    fn: (_c, input) => {
      if (input.length !== 1) return EMPTY;
      const v = primitiveValue(input[0]);
      if (typeof v === 'number') return int(decimalPlaces(input[0]));
      if (v instanceof FpTemporal)
        return int(v.text.replace(/[^0-9]/g, '').length);
      return EMPTY;
    },
  },
  /* Strings (2.1) */
  trim: {
    arity: [0, 0],
    fn: (_c, input) => {
      const v = inputString(input, 'trim');
      return v === undefined ? EMPTY : str(v.trim());
    },
  },
  split: {
    arity: [1, 1],
    fn: (ctx, input, [sep]) => {
      const v = inputString(input, 'split');
      const by = argString(ctx, sep, 'split');
      if (v === undefined || by === undefined) return EMPTY;
      return v.split(by).map(x => new Item(x, 'System.String'));
    },
  },
  join: {
    arity: [0, 1],
    fn: (ctx, input, [sep]) => {
      if (!input.length) return EMPTY;
      const by = sep ? (argString(ctx, sep, 'join') ?? '') : '';
      return str(
        input
          .map(i => {
            if (typeof i.v !== 'string')
              throw new FhirPathError('join() takes Strings');
            return i.v;
          })
          .join(by),
      );
    },
  },
  encode: {
    arity: [1, 1],
    fn: (ctx, input, [f]) => codec(ctx, input, f, 'encode'),
  },
  decode: {
    arity: [1, 1],
    fn: (ctx, input, [f]) => codec(ctx, input, f, 'decode'),
  },
  escape: {
    arity: [1, 1],
    fn: (ctx, input, [f]) => codec(ctx, input, f, 'escape'),
  },
  unescape: {
    arity: [1, 1],
    fn: (ctx, input, [f]) => codec(ctx, input, f, 'unescape'),
  },

  /* Ordering */
  sort: {
    arity: [0, 9],
    fn: (ctx, input, keys) => {
      const rows = input.map((item, i) => ({
        item,
        keys: keys.map(k => {
          const r = k(on(ctx, item, i));
          if (r.length > 1)
            throw new FhirPathError('A sort() key must be a single item');
          return r[0];
        }),
      }));
      const order = keys.length
        ? keys.map(k => ((k as { descending?: boolean }).descending ? -1 : 1))
        : [1];
      rows.sort((x, y) => {
        const xs = keys.length ? x.keys : [x.item];
        const ys = keys.length ? y.keys : [y.item];
        for (let k = 0; k < order.length; k++) {
          const a = xs[k];
          const b = ys[k];
          // empty first, either way
          if (!a || !b) {
            if (a !== b) return a ? 1 : -1;
            continue;
          }
          const c = itemCompare(a, b);
          if (c === undefined)
            throw new FhirPathError(
              `Cannot sort ${typeLabel(a)} with ${typeLabel(b)}`,
            );
          if (c) return c * order[k];
        }
        return 0;
      });
      return rows.map(r => r.item);
    },
  },

  /* Reflection */
  defineVariable: {
    arity: [1, 2],
    fn: (ctx, input, [n, value]) => {
      const name = argString(ctx, n, 'defineVariable');
      if (name === undefined)
        throw new FhirPathError('defineVariable() needs a name');
      if (ctx.scope?.[name] !== undefined || isSystemVariable(ctx.env, name))
        throw new FhirPathError(
          `defineVariable(): %${name} is already defined`,
        );
      // the value: evaluated on the whole input, as $this
      const v = value
        ? value({ ...ctx, focus: input, index: undefined })
        : input;
      return withScope(input, { ...ctx.scope, [name]: v });
    },
  },
  type: {
    arity: [0, 0],
    fn: (ctx, input) =>
      input.map(i => {
        const [namespace, name] = typeOf(ctx, i);
        return new Item({ namespace, name }, 'System.ClassInfo');
      }),
  },
};

/**
 * The resource a reference names: a contained one ('#id'), an entry of the
 * Bundle being evaluated, or one the caller's resolver finds
 */
function resolveReference(ctx: EvalContext, ref: string): unknown {
  const root = ctx.env.vars.rootResource?.[0]?.v;
  const resource = ctx.env.vars.resource?.[0]?.v;
  if (ref.startsWith('#')) {
    const id = ref.slice(1);
    for (const r of [resource, root])
      if (r && Array.isArray(r.contained)) {
        const c = r.contained.find((x: any) => x?.id === id);
        if (c) return c;
      }
    return;
  }
  for (const r of [root, resource]) {
    if (r?.resourceType !== 'Bundle' || !Array.isArray(r.entry)) continue;
    for (const e of r.entry) {
      const res = e?.resource;
      if (!res) continue;
      if (e.fullUrl === ref) return res;
      if (
        `${res.resourceType}/${res.id}` === ref ||
        (e.fullUrl && e.fullUrl.endsWith('/' + ref))
      )
        return res;
    }
  }
  return ctx.env.resolve?.(ref, ctx);
}

/** lowBoundary(), highBoundary(): the least and greatest value a decimal, quantity or date could be */
function boundary(
  ctx: EvalContext,
  input: Item[],
  p: Fn | undefined,
  dir: -1 | 1,
): Item[] {
  if (input.length !== 1) return EMPTY;
  const item = input[0];
  const v = primitiveValue(item);
  const precision = p
    ? argInteger(ctx, p, dir < 0 ? 'lowBoundary' : 'highBoundary')
    : undefined;
  if (typeof v === 'number') {
    const text = decimalBoundary(
      decimalText(item) ?? String(v),
      precision ?? 8,
      dir,
    );
    return text === undefined
      ? EMPTY
      : [new Item(Number(text), 'System.Decimal', text)];
  }
  if (v instanceof FpQuantity) {
    const text = decimalBoundary(
      v.text ?? String(v.value),
      precision ?? 8,
      dir,
    );
    return text === undefined
      ? EMPTY
      : [
          new Item(
            new FpQuantity(Number(text), v.unit, text),
            'System.Quantity',
          ),
        ];
  }
  if (v instanceof FpTemporal) {
    const t = temporalBoundary(v, precision, dir);
    return t ? [new Item(t, `System.${t.kind}`)] : EMPTY;
  }
  return EMPTY;
}

/**
 * The boundary of a decimal written as `text`: half a unit of its last place
 * away, rounded down (low) or up (high) to `places`; exact, with BigInt
 */
function decimalBoundary(
  text: string,
  places: number,
  dir: -1 | 1,
): string | undefined {
  if (!Number.isInteger(places) || places < 0 || places > 28) return;
  const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!m) return;
  // places of the last digit written; 9.5e2 has -1 (its unit is 10)
  const own = (m[3]?.length ?? 0) - Number(m[4] ?? 0);
  const scale = Math.max(own + 1, places, 0);
  const pow = (n: number) => 10n ** BigInt(n);
  let n = BigInt(m[2] + (m[3] ?? '')) * pow(scale - own);
  if (m[1] === '-') n = -n;
  const half = 5n * pow(scale - own - 1);
  const b = dir < 0 ? n - half : n + half;
  // to `places`: floor for low, ceiling for high
  const unit = pow(scale - places);
  let q = b / unit;
  const r = b % unit;
  if (r !== 0n && (dir < 0 ? b < 0n : b > 0n)) q += dir < 0 ? -1n : 1n;
  const neg = q < 0n || (q === 0n && b < 0n);
  const digits = (q < 0n ? -q : q).toString().padStart(places + 1, '0');
  const int = digits.slice(0, digits.length - places);
  const frac = places ? '.' + digits.slice(digits.length - places) : '';
  return (neg ? '-' : '') + int + frac;
}

/** The precision (digits) of each part: year 4, month 6, day 8, hour 10, minute 12, second 14, millisecond 17 */
const DATE_DIGITS = [4, 6, 8, 10, 12, 14, 17];
const TIME_DIGITS = [2, 4, 6, 9];

function temporalBoundary(
  v: FpTemporal,
  precision: number | undefined,
  dir: -1 | 1,
): FpTemporal | undefined {
  const isTime = v.kind === 'Time';
  const digits = isTime ? TIME_DIGITS : DATE_DIGITS;
  const want = precision ?? (v.kind === 'Date' ? 8 : digits[digits.length - 1]);
  const parts = digits.indexOf(want) + 1; // parts wanted, the last being milliseconds
  if (!parts) return;
  const lo = [0, 1, 1, 0, 0, 0, 0];
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const offset = isTime ? 3 : 0;
  const have = v.parts.map(x => x);
  const values: number[] = [];
  for (let i = 0; i < parts; i++) {
    const k = i + offset; // index in year..ms
    if (k === 6) {
      const sec = have[5 - offset] ?? (dir < 0 ? 0 : 59);
      const frac = Math.round((sec % 1) * 1000);
      values.push(
        have[5 - offset] !== undefined && sec % 1 !== 0
          ? frac
          : dir < 0
            ? 0
            : 999,
      );
      continue;
    }
    const given = have[i];
    if (given !== undefined) values.push(Math.trunc(given));
    else if (dir < 0) values.push(lo[k]);
    else if (k === 1) values.push(12);
    else if (k === 2)
      values.push(new Date(Date.UTC(values[0], values[1], 0)).getUTCDate());
    else values.push(k === 3 ? 23 : 59);
  }
  let text = '';
  for (let i = 0; i < values.length; i++) {
    const k = i + offset;
    if (k === 0) text += pad(values[i], 4);
    else if (k === 1 || k === 2) text += '-' + pad(values[i]);
    else if (k === 3) text += (isTime ? '' : 'T') + pad(values[i]);
    else if (k === 4 || k === 5) text += ':' + pad(values[i]);
    else text += '.' + pad(values[i], 3);
  }
  if (!isTime && parts > 3) {
    const tz = v.text.match(/(Z|[+-]\d{2}:\d{2})$/)?.[1];
    text += tz ?? (dir < 0 ? '+14:00' : '-12:00');
  }
  return new FpTemporal(v.kind, text);
}

// convertsToX(): whether toX() gives a value
for (const t of [
  'Boolean',
  'Integer',
  'Decimal',
  'String',
  'Quantity',
  'Date',
  'DateTime',
  'Time',
]) {
  const to = FUNCTIONS[`to${t}`];
  FUNCTIONS[`convertsTo${t}`] = {
    arity: [0, 0],
    fn: (ctx, input, args) => {
      if (!input.length) return EMPTY;
      if (input.length > 1)
        throw new FhirPathError(
          `convertsTo${t}() expects a single item, got ${input.length}`,
        );
      return bool(to.fn(ctx, input, args).length > 0);
    },
  };
}

/** The elements a FHIR narrative may have (the XHTML subset of the specification) */
const NARRATIVE_ELEMENTS = new Set(
  (
    'a abbr acronym address b bdo big blockquote br caption cite code col colgroup dd dfn div dl dt em ' +
    'h1 h2 h3 h4 h5 h6 hr i img kbd li ol p pre q samp small span strong sub sup table tbody td tfoot th ' +
    'thead tr tt ul var'
  ).split(' '),
);

/** A quantity from a number, a quantity or a string ('4 days', "1.5 'mg'") */
function toQuantity(input: Item[]): FpQuantity | undefined {
  if (input.length !== 1) return;
  const i = input[0];
  const v = primitiveValue(i);
  if (typeof v === 'boolean') return new FpQuantity(v ? 1 : 0, '1');
  if (typeof v === 'number') return new FpQuantity(v, '1', decimalText(i));
  if (v instanceof FpQuantity) return v;
  if (typeof v === 'string') {
    const m = /^\s*([+-]?\d+(?:\.\d+)?)\s*(?:'([^']+)'|([a-z]+))?\s*$/.exec(v);
    if (!m) return;
    const unit = m[2] ?? m[3] ?? '1';
    if (m[3] && !new FpQuantity(0, m[3]).isCalendar) return;
    return new FpQuantity(Number(m[1]), unit, m[1]);
  }
  const q = quantityOf(i);
  return q;
}

function toTemporal(input: Item[], kind: 'Date' | 'DateTime' | 'Time'): Item[] {
  if (input.length !== 1) return EMPTY;
  const v = primitiveValue(input[0]);
  let text: string | undefined;
  if (typeof v === 'string') text = v;
  else if (v instanceof FpTemporal) {
    if (kind === 'Time' ? v.kind !== 'Time' : v.kind === 'Time') return EMPTY;
    text =
      kind === 'Date'
        ? v.text.slice(0, Math.min(v.text.length, 10)).replace(/T.*$/, '')
        : v.text;
  }
  if (text === undefined) return EMPTY;
  try {
    const t = new FpTemporal(
      kind,
      text.startsWith('@') ? text.slice(1).replace(/^T/, '') : text,
    );
    if (kind === 'Date' && t.parts.length > 3) return EMPTY;
    return [new Item(t, `System.${kind}`)];
  } catch {
    return EMPTY;
  }
}

function codec(ctx: EvalContext, input: Item[], f: Fn, name: string): Item[] {
  const v = inputString(input, name);
  const format = argString(ctx, f, name);
  if (v === undefined || format === undefined) return EMPTY;
  // portable: no Buffer, the engine runs in browsers too
  const bytes = (s: string) => new TextEncoder().encode(s);
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  const b64 = (s: string) => btoa(String.fromCharCode(...bytes(s)));
  switch (`${name}:${format}`) {
    case 'encode:base64':
      return str(b64(v));
    case 'encode:urlbase64':
      return str(b64(v).replace(/\+/g, '-').replace(/\//g, '_'));
    case 'encode:hex':
      return str(
        [...bytes(v)].map(b => b.toString(16).padStart(2, '0')).join(''),
      );
    case 'decode:base64':
    case 'decode:urlbase64':
      try {
        return str(
          text(
            Uint8Array.from(atob(v.replace(/-/g, '+').replace(/_/g, '/')), c =>
              c.charCodeAt(0),
            ),
          ),
        );
      } catch {
        return EMPTY;
      }
    case 'decode:hex':
      if (!/^(?:[0-9a-f]{2})*$/i.test(v)) return EMPTY;
      return str(
        text(Uint8Array.from(v.match(/../g) ?? [], h => parseInt(h, 16))),
      );
    case 'escape:html':
      return str(
        v
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;'),
      );
    case 'unescape:html':
      return str(
        v.replace(
          /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
          (_m, e: string) => {
            const named: Record<string, string> = {
              amp: '&',
              lt: '<',
              gt: '>',
              quot: '"',
              apos: "'",
            };
            if (e[0] !== '#') return named[e.toLowerCase()];
            return String.fromCodePoint(
              e[1] === 'x' || e[1] === 'X'
                ? parseInt(e.slice(2), 16)
                : Number(e.slice(1)),
            );
          },
        ),
      );
    case 'escape:json':
      return str(JSON.stringify(v).slice(1, -1));
    case 'unescape:json':
      try {
        return str(JSON.parse(`"${v.replace(/(^|[^\\])"/g, '$1\\"')}"`));
      } catch {
        return EMPTY;
      }
    default:
      throw new FhirPathError(`${name}() does not know the format "${format}"`);
  }
}

/** [namespace, name] of an item's type */
function typeOf(ctx: EvalContext, i: Item): [string, string] {
  if (i.t && !i.t.startsWith('System.')) {
    const name = i.t.includes('.') && ctx.env.model?.hasType(i.t) ? i.t : i.t;
    return ['FHIR', name];
  }
  if (
    !i.t &&
    i.v &&
    typeof i.v === 'object' &&
    typeof (i.v as any).resourceType === 'string'
  )
    return ['FHIR', (i.v as any).resourceType];
  return ['System', systemType(i) ?? 'Any'];
}
