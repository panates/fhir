import { SYSTEM_TYPE_OF_PRIMITIVE } from './model.js';
import { canonical, sameDims } from './ucum.js';

/**
 * An item of a FHIRPath collection: the value, its type when known (a FHIR
 * type name, a backbone path, or 'System.X'), and for a FHIR primitive the
 * element holding its id and extensions (the JSON `_x` sibling).
 */
export class Item {
  constructor(
    readonly v: any,
    readonly t?: string,
    /** A FHIR primitive's `_x` element (id, extensions); for a System decimal, its text */
    readonly x?: any,
    /** A FHIR decimal's text as read (1.50), for its precision */
    readonly s?: string,
  ) {}
}

/** The text a decimal was written with, when known: 1.50 rather than 1.5 */
export const decimalText = (item: Item): string | undefined =>
  item.s ?? (typeof item.x === 'string' ? item.x : undefined);

/** Where @fhirjs/core keeps the text of the decimals it reads (fhir-core's DECIMAL_TEXT) */
export const DECIMAL_TEXT = Symbol.for('fhir.decimalText');

/** A FHIRPath runtime error (not a false or empty result) */
export class FhirPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FhirPathError';
  }
}

/* ------------------------------------------------------------------ */
/* Date, DateTime, Time                                               */
/* ------------------------------------------------------------------ */

/** A date, dateTime or time with the precision it is written with */
export class FpTemporal {
  /** year, month, day, hour, minute, second (with its fraction) */
  readonly parts: number[];
  /** Offset in minutes; undefined when not given */
  readonly tz?: number;

  constructor(
    readonly kind: 'Date' | 'DateTime' | 'Time',
    readonly text: string,
  ) {
    const parts: number[] = [];
    let rest = text;
    if (kind !== 'Time') {
      const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(rest);
      if (!m) throw new FhirPathError(`"${text}" is not a ${kind}`);
      parts.push(+m[1]);
      if (m[2]) parts.push(+m[2]);
      if (m[3]) parts.push(+m[3]);
      rest = rest.slice(m[0].length);
      if (rest.startsWith('T')) rest = rest.slice(1);
    }
    if (rest) {
      const m =
        /^(\d{2})(?::(\d{2})(?::(\d{2}(?:\.\d+)?))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(
          rest,
        );
      if (m) {
        // a time continues the parts after the date's three
        if (kind !== 'Time' && parts.length < 3)
          throw new FhirPathError(`"${text}" is not a ${kind}`);
        parts.push(+m[1]);
        if (m[2]) parts.push(+m[2]);
        if (m[3]) parts.push(+m[3]);
        if (m[4])
          this.tz =
            m[4] === 'Z'
              ? 0
              : (m[4][0] === '-' ? -1 : 1) *
                (+m[4].slice(1, 3) * 60 + +m[4].slice(4, 6));
      } else if (!/^(Z|[+-]\d{2}:\d{2})$/.test(rest))
        throw new FhirPathError(`"${text}" is not a ${kind}`);
    }
    this.parts = parts;
  }

  /** Comparison: -1, 0, 1, or undefined when the precisions do not allow one */
  compare(o: FpTemporal): number | undefined {
    const timeOnly = this.kind === 'Time';
    if (timeOnly !== (o.kind === 'Time')) return;
    let a = this.parts;
    let b = o.parts;
    // a time on both, an offset on one only: not comparable
    if (
      !timeOnly &&
      a.length > 3 &&
      b.length > 3 &&
      (this.tz === undefined) !== (o.tz === undefined)
    )
      return;
    // both with an offset and a time: compare in UTC
    if (
      this.tz !== undefined &&
      o.tz !== undefined &&
      this.tz !== o.tz &&
      !timeOnly &&
      a.length > 3 &&
      b.length > 3
    ) {
      a = utcParts(a, this.tz);
      b = utcParts(b, o.tz);
    }
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length === b.length ? 0 : undefined;
  }

  toString(): string {
    return this.text;
  }
}

function utcParts(p: number[], tz: number): number[] {
  const d = new Date(
    Date.UTC(
      p[0],
      (p[1] ?? 1) - 1,
      p[2] ?? 1,
      p[3] ?? 0,
      (p[4] ?? 0) - tz,
      0,
      0,
    ),
  );
  const out = [
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
  ];
  if (p.length > 5) out.push(p[5]);
  return out.slice(0, p.length);
}

/* ------------------------------------------------------------------ */
/* Quantity                                                           */
/* ------------------------------------------------------------------ */

/** Calendar duration words that equal a UCUM unit (a day is 1 'd') */
const CALENDAR_UCUM: Record<string, string> = {
  week: 'wk',
  weeks: 'wk',
  day: 'd',
  days: 'd',
  hour: 'h',
  hours: 'h',
  minute: 'min',
  minutes: 'min',
  second: 's',
  seconds: 's',
  millisecond: 'ms',
  milliseconds: 'ms',
};
/** Calendar years and months: not equal to UCUM 'a' and 'mo', only to themselves */
const CALENDAR_YM: Record<string, string> = {
  year: 'year',
  years: 'year',
  month: 'month',
  months: 'month',
};

/** A System.Quantity: a decimal value and a unit (UCUM or a calendar word) */
export class FpQuantity {
  constructor(
    readonly value: number,
    readonly unit: string,
    /** The value as written (4.0000), for precision */
    readonly text?: string,
  ) {}

  get isCalendar(): boolean {
    return this.unit in CALENDAR_UCUM || this.unit in CALENDAR_YM;
  }

  /** The UCUM unit it compares as; a calendar year or month has none */
  get ucum(): string | undefined {
    if (this.unit in CALENDAR_YM) return;
    return CALENDAR_UCUM[this.unit] ?? (this.unit || '1');
  }

  toString(): string {
    return this.isCalendar
      ? `${this.value} ${this.unit}`
      : `${this.value} '${this.unit}'`;
  }
}

/**
 * Two quantities as numbers in the same unit: { a, b, factor } (b in a's unit);
 * undefined when they cannot be compared (a calendar year with 1 'a', different dimensions)
 */
export function quantityPair(
  x: FpQuantity,
  y: FpQuantity,
): { a: number; b: number } | undefined {
  const xy = CALENDAR_YM[x.unit];
  const yy = CALENDAR_YM[y.unit];
  if (xy || yy) return xy === yy ? { a: x.value, b: y.value } : undefined;
  if (x.ucum === y.ucum) return { a: x.value, b: y.value };
  const cx = canonical(x.ucum!);
  const cy = canonical(y.ucum!);
  if (!cx || !cy || !sameDims(cx, cy)) return;
  return { a: x.value, b: round12((y.value * cy.factor) / cx.factor) };
}

/** Rounds away float noise: 4000 * 0.001 is 4 */
export const round12 = (n: number) => Number(n.toPrecision(12));

/** A FHIR Quantity (or Duration, Age ...) object as a System.Quantity */
export function quantityOf(item: Item): FpQuantity | undefined {
  const v = item.v;
  if (v instanceof FpQuantity) return v;
  if (v && typeof v === 'object' && typeof v.value === 'number')
    return new FpQuantity(v.value, String(v.code ?? v.unit ?? '1'));
  return;
}

/* ------------------------------------------------------------------ */
/* Types of items                                                     */
/* ------------------------------------------------------------------ */

/** FHIR's Quantity and its specializations, which compare as System Quantities */
const FHIR_QUANTITIES = new Set([
  'Quantity',
  'Age',
  'Duration',
  'Distance',
  'Count',
  'MoneyQuantity',
  'SimpleQuantity',
]);

/** The System type of an item: 'Boolean', 'Integer' ..., or undefined for a complex value */
export function systemType(item: Item): string | undefined {
  const t = item.t;
  if (t) {
    if (t.startsWith('System.')) return t.slice(7);
    const s = SYSTEM_TYPE_OF_PRIMITIVE[t];
    if (s) return s;
    if (
      t === 'Quantity' ||
      t === 'Age' ||
      t === 'Duration' ||
      t === 'Distance' ||
      t === 'Count' ||
      t === 'MoneyQuantity' ||
      t === 'SimpleQuantity'
    )
      return;
  }
  const v = item.v;
  switch (typeof v) {
    case 'boolean':
      return 'Boolean';
    case 'string':
      return 'String';
    case 'number':
      return Number.isInteger(v) ? 'Integer' : 'Decimal';
  }
  if (v instanceof FpTemporal) return v.kind;
  if (v instanceof FpQuantity) return 'Quantity';
  return;
}

/** The value of an item as FHIRPath compares it: dates as FpTemporal */
export function primitiveValue(item: Item): unknown {
  const v = item.v;
  if (typeof v === 'string') {
    const st = systemType(item);
    if (st === 'Date' || st === 'DateTime' || st === 'Time') {
      try {
        return new FpTemporal(st, v);
      } catch {
        return v;
      }
    }
  }
  return v;
}

/* ------------------------------------------------------------------ */
/* Equality                                                           */
/* ------------------------------------------------------------------ */

/** = of two items: true, false, or undefined (empty: precisions differ) */
export function itemEquals(a: Item, b: Item): boolean | undefined {
  const av = primitiveValue(a);
  const bv = primitiveValue(b);
  if (av instanceof FpTemporal || bv instanceof FpTemporal) {
    if (!(av instanceof FpTemporal) || !(bv instanceof FpTemporal)) {
      // a date written as a string on one side: compare as that type
      const kind = av instanceof FpTemporal ? av.kind : (bv as FpTemporal).kind;
      try {
        const x =
          av instanceof FpTemporal ? av : new FpTemporal(kind, String(av));
        const y =
          bv instanceof FpTemporal ? bv : new FpTemporal(kind, String(bv));
        const c = x.compare(y);
        return c === undefined ? undefined : c === 0;
      } catch {
        return false;
      }
    }
    if ((av.kind === 'Time') !== (bv.kind === 'Time')) return false;
    const c = av.compare(bv);
    return c === undefined ? undefined : c === 0;
  }
  const aq =
    av instanceof FpQuantity
      ? av
      : FHIR_QUANTITIES.has(a.t!)
        ? quantityOf(a)
        : undefined;
  const bq =
    bv instanceof FpQuantity
      ? bv
      : FHIR_QUANTITIES.has(b.t!)
        ? quantityOf(b)
        : undefined;
  if (aq || bq) {
    const x = aq ?? quantityOf(a);
    const y = bq ?? quantityOf(b);
    if (!x || !y) return false;
    // not comparable (a calendar year against 1 'a', 'tablets' against no unit): empty
    const p = quantityPair(x, y);
    return p ? p.a === p.b : undefined;
  }
  if (
    av !== null &&
    typeof av === 'object' &&
    bv !== null &&
    typeof bv === 'object'
  )
    return deepEqual(av, bv);
  return av === bv;
}

/** ~ of two items */
export function itemEquivalent(a: Item, b: Item): boolean {
  const av = primitiveValue(a);
  const bv = primitiveValue(b);
  if (typeof av === 'string' && typeof bv === 'string')
    return normalizeString(av) === normalizeString(bv);
  if (typeof av === 'number' && typeof bv === 'number') {
    // to the precision of the less precise
    const p = Math.min(decimals(av, a), decimals(bv, b));
    return av.toFixed(p) === bv.toFixed(p);
  }
  if (av instanceof FpTemporal && bv instanceof FpTemporal)
    return av.compare(bv) === 0;
  if (av instanceof FpQuantity || bv instanceof FpQuantity) {
    let x = av instanceof FpQuantity ? av : quantityOf(a);
    let y = bv instanceof FpQuantity ? bv : quantityOf(b);
    if (!x || !y) return false;
    // equivalence lets a calendar year be 1 'a' and a month 1 'mo'
    if (CALENDAR_YM[x.unit] && !CALENDAR_YM[y.unit])
      x = new FpQuantity(
        x.value,
        x.unit.startsWith('year') ? 'a' : 'mo',
        x.text,
      );
    if (CALENDAR_YM[y.unit] && !CALENDAR_YM[x.unit])
      y = new FpQuantity(
        y.value,
        y.unit.startsWith('year') ? 'a' : 'mo',
        y.text,
      );
    const p = quantityPair(x, y);
    if (!p) return false;
    // to the precision of the less precise
    const places = Math.min(
      textPlaces(x!.text ?? String(x!.value)),
      textPlaces(y!.text ?? String(y!.value)),
    );
    return p.a.toFixed(places) === p.b.toFixed(places);
  }
  return itemEquals(a, b) === true;
}

const normalizeString = (s: string) =>
  s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Decimal places of a number as written */
export function textPlaces(text: string): number {
  const i = text.indexOf('.');
  return i < 0 ? 0 : text.length - i - 1;
}

function decimals(n: number, item: Item): number {
  const text = decimalText(item) ?? String(n);
  const i = text.indexOf('.');
  return i < 0 ? 0 : text.length - i - 1;
}

/** Equality of two complex values: the same children, recursively */
export function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  )
    return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof FpQuantity || a instanceof FpTemporal)
    return String(a) === String(b);
  const ka = Object.keys(a).filter(k => a[k] !== undefined);
  const kb = Object.keys(b).filter(k => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

/** Ordering of two singletons for < > <= >=: a number, or undefined (empty) */
export function itemCompare(a: Item, b: Item): number | undefined {
  const av = primitiveValue(a);
  const bv = primitiveValue(b);
  // a primitive with only extensions has no value to compare
  if (av === null || bv === null) return undefined;
  if (typeof av === 'number' && typeof bv === 'number')
    return av < bv ? -1 : av > bv ? 1 : 0;
  if (typeof av === 'string' && typeof bv === 'string')
    return av < bv ? -1 : av > bv ? 1 : 0;
  if (av instanceof FpTemporal || bv instanceof FpTemporal) {
    try {
      const kind = av instanceof FpTemporal ? av.kind : (bv as FpTemporal).kind;
      const x =
        av instanceof FpTemporal ? av : new FpTemporal(kind, String(av));
      const y =
        bv instanceof FpTemporal ? bv : new FpTemporal(kind, String(bv));
      return x.compare(y);
    } catch {
      throw new FhirPathError(
        `Cannot compare ${String(av)} with ${String(bv)}`,
      );
    }
  }
  const x = quantityOf(a) ?? (av instanceof FpQuantity ? av : undefined);
  const y = quantityOf(b) ?? (bv instanceof FpQuantity ? bv : undefined);
  if (x && y) {
    const p = quantityPair(x, y);
    return p ? (p.a < p.b ? -1 : p.a > p.b ? 1 : 0) : undefined;
  }
  throw new FhirPathError(
    `Cannot compare ${typeLabel(a)} with ${typeLabel(b)}`,
  );
}

export function typeLabel(item: Item): string {
  return item.t ?? systemType(item) ?? typeof item.v;
}
