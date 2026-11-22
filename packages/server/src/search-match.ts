import { type FhirContext, fhirPathModelOf } from '@fhirjs/core';
import { FhirPath, type Item } from '@fhirjs/fhirpath';
import { FhirServerError } from './fhir-server-error.js';
import {
  dateRange,
  type SearchComponent,
  type SearchCriterion,
  type SearchLookup,
  type SearchSort,
  type SearchValue,
} from './search-query.js';

/**
 * Matches resources against search criteria by the FHIRPath expressions of
 * their parameters: what a store without a query language of its own (the
 * memory store) searches with.
 */
export class SearchMatcher {
  private readonly _fp: FhirPath;

  constructor(fhir: FhirContext) {
    this._fp = new FhirPath({
      model: fhirPathModelOf(fhir.model),
      // .where(resolve() is Patient): the type of a reference is in its text
      resolve: ref => {
        const m = /(?:^|\/)([A-Z][A-Za-z]+)\/[A-Za-z0-9\-.]{1,64}$/.exec(
          ref.replace(/\/_history\/[^/]+$/, ''),
        );
        return m ? { resourceType: m[1] } : undefined;
      },
    });
  }

  /**
   * Whether a resource matches every criterion. `baseUrl` is the server's:
   * an absolute reference under it is a local one.
   */
  matches(
    resource: Record<string, any>,
    criteria: readonly SearchCriterion[],
    baseUrl = '',
    lookup?: SearchLookup,
  ): boolean {
    return criteria.every(c => this._matches(resource, c, baseUrl, lookup));
  }

  /**
   * The resources a resource refers to by a reference parameter, as
   * `Type/id`: the local ones only (relative, or absolute under `baseUrl`)
   */
  references(
    resource: Record<string, any>,
    param: SearchCriterion['param'],
    baseUrl = '',
  ): string[] {
    const out: string[] = [];
    for (const item of this._values(resource, { param, values: [] })) {
      const ref = localReference(item, baseUrl);
      if (ref && !out.includes(ref)) out.push(ref);
    }
    return out;
  }

  private _matches(
    resource: Record<string, any>,
    c: SearchCriterion,
    baseUrl: string,
    lookup: SearchLookup | undefined,
  ): boolean {
    if (c.chain || c.has) {
      if (!lookup)
        throw new FhirServerError(
          500,
          `${c.param.code}: a chained criterion needs the store's resources`,
          'exception',
        );
      if (c.chain) {
        const chain = c.chain;
        return this.references(resource, c.param, baseUrl).some(ref => {
          const [type, id] = ref.split('/');
          if (type !== chain.type) return false;
          const target = lookup.read(type, id);
          return (
            !!target && this.matches(target, chain.criteria, baseUrl, lookup)
          );
        });
      }
      const has = c.has!;
      const self = `${resource.resourceType}/${resource.id}`;
      for (const r of lookup.all(has.type))
        if (
          this.references(r, c.param, baseUrl).includes(self) &&
          this.matches(r, has.criteria, baseUrl, lookup)
        )
          return true;
      return false;
    }
    let items = this._values(resource, c);
    // a composite's item has a value when each of its components has one
    if (c.components)
      items = items.filter(i =>
        c.components!.every(k => this._parts(resource, k, i).length),
      );
    if (c.missing !== undefined) return c.missing === !items.length;
    const any = c.values.some(v =>
      items.some(i =>
        c.components
          ? this._compositeMatches(resource, c.components, i, v, baseUrl)
          : this._valueMatches(c, i, v, baseUrl),
      ),
    );
    return c.modifier === 'not' ? !any : any;
  }

  /** The values of a parameter in a resource */
  private _values(resource: Record<string, any>, c: SearchCriterion): Item[] {
    const expression = c.param.expression;
    if (!expression)
      throw new FhirServerError(
        400,
        `${c.param.code} cannot be searched here`,
        'not-supported',
      );
    try {
      return this._fp.compile(expression).evaluateItems(resource);
    } catch {
      // data the expression cannot take (as() on several values): no values
      return [];
    }
  }

  /** Whether one item of a composite matches every component's value */
  private _compositeMatches(
    resource: Record<string, any>,
    components: readonly SearchComponent[],
    item: Item,
    v: SearchValue,
    baseUrl: string,
  ): boolean {
    return components.every((comp, k) => {
      const c: SearchCriterion = { param: comp.param, values: [] };
      return this._parts(resource, comp, item).some(p =>
        this._valueMatches(c, p, v.components![k], baseUrl),
      );
    });
  }

  /** The values of a component, from an item of its composite */
  private _parts(
    resource: Record<string, any>,
    comp: SearchComponent,
    item: Item,
  ): Item[] {
    try {
      return this._fp
        .compile(comp.expression)
        .evaluateItems(item, { resource });
    } catch {
      return [];
    }
  }

  private _valueMatches(
    c: SearchCriterion,
    item: Item,
    v: SearchValue,
    baseUrl: string,
  ): boolean {
    switch (c.param.type) {
      case 'token':
        return c.modifier === 'text' ? tokenText(item, v.raw) : token(item, v);
      case 'string':
        return strings(item).some(s => stringMatches(s, v.raw, c.modifier));
      case 'date':
        return dateRanges(item).some(([t1, t2]) => dateMatches(v, t1, t2));
      case 'reference':
        return this._reference(item, v, baseUrl);
      case 'number':
        return typeof item.v === 'number' && numberMatches(v, item.v);
      case 'quantity':
        return quantityMatches(item, v);
      case 'uri':
        return uriMatches(item, v.uri!, c.modifier);
      default:
        return false;
    }
  }

  /**
   * The order of two resources by _sort: each parameter in turn, by its
   * first value (the lowest ascending, the highest descending); a resource
   * without a value comes last either way
   */
  compare(
    a: Record<string, any>,
    b: Record<string, any>,
    sort: readonly SearchSort[],
  ): number {
    for (const s of sort) {
      const ka = this._sortKey(a, s);
      const kb = this._sortKey(b, s);
      if (ka === kb) continue;
      if (ka === undefined) return 1;
      if (kb === undefined) return -1;
      const c = ka < kb ? -1 : 1;
      return s.descending ? -c : c;
    }
    return 0;
  }

  private _sortKey(
    resource: Record<string, any>,
    s: SearchSort,
  ): number | string | undefined {
    if (!s.param.expression) return;
    let items: Item[];
    try {
      items = this._fp.compile(s.param.expression).evaluateItems(resource);
    } catch {
      return;
    }
    const keys = items.flatMap(i => sortKeys(s.param.type, i));
    if (!keys.length) return;
    return keys.reduce((x, y) => ((s.descending ? y > x : y < x) ? y : x));
  }

  private _reference(item: Item, v: SearchValue, baseUrl: string): boolean {
    let ref = referenceText(item);
    if (!ref) return false;
    ref = ref.replace(/\/_history\/[^/]+$/, '');
    if (v.url && ref === v.url) return true;
    if (baseUrl && ref.startsWith(baseUrl + '/'))
      ref = ref.slice(baseUrl.length + 1);
    if (v.url && !(baseUrl && v.url.startsWith(baseUrl + '/'))) return false;
    const m = /^([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})$/.exec(ref);
    if (!m) return false;
    return m[2] === v.id && (!v.type || m[1] === v.type);
  }
}

/** The text of a reference item: a Reference's reference, or a canonical or uri */
function referenceText(item: Item): string | undefined {
  const val: any = item.v;
  const ref =
    item.t === 'Reference'
      ? val?.reference
      : typeof val === 'string'
        ? val
        : undefined;
  return typeof ref === 'string' && ref ? ref : undefined;
}

/** A local reference as Type/id: relative, or absolute under the base; undefined otherwise */
function localReference(item: Item, baseUrl: string): string | undefined {
  let ref = referenceText(item);
  if (!ref) return;
  ref = ref.replace(/\/_history\/[^/]+$/, '');
  if (baseUrl && ref.startsWith(baseUrl + '/'))
    ref = ref.slice(baseUrl.length + 1);
  return /^[A-Z][A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$/.test(ref) ? ref : undefined;
}

/* ------------------------------------------------------------------ */
/* Tokens                                                             */
/* ------------------------------------------------------------------ */

function codeMatches(v: SearchValue, system: unknown, code: unknown): boolean {
  if (v.code !== undefined && code !== v.code) return false;
  if (v.system === undefined) return v.code !== undefined;
  if (v.system === '') return system === undefined || system === null;
  return system === v.system;
}

function token(item: Item, v: SearchValue): boolean {
  const val: any = item.v;
  switch (item.t) {
    case 'CodeableConcept':
      return (val?.coding ?? []).some((c: any) =>
        codeMatches(v, c?.system, c?.code),
      );
    case 'Coding':
      return codeMatches(v, val?.system, val?.code);
    case 'Identifier':
      return codeMatches(v, val?.system, val?.value);
    case 'ContactPoint':
      return (
        codeMatches(v, undefined, val?.value) ||
        (v.system !== undefined &&
          v.system !== '' &&
          codeMatches(v, val?.system, val?.value))
      );
  }
  // a primitive: a code without a system
  if (val === null || typeof val === 'object') return false;
  return codeMatches(v, undefined, String(val));
}

/** :text: the text of a CodeableConcept, the display of a Coding */
function tokenText(item: Item, text: string): boolean {
  const val: any = item.v;
  const texts: unknown[] =
    item.t === 'CodeableConcept'
      ? [val?.text, ...(val?.coding ?? []).map((c: any) => c?.display)]
      : item.t === 'Coding'
        ? [val?.display]
        : item.t === 'Identifier'
          ? [val?.type?.text]
          : [];
  return texts.some(
    t => typeof t === 'string' && stringMatches(t, text, undefined),
  );
}

/* ------------------------------------------------------------------ */
/* Strings                                                            */
/* ------------------------------------------------------------------ */

/** Case and accents removed; Turkish dotless ı read as i */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i');
}

function stringMatches(
  s: string,
  search: string,
  modifier: string | undefined,
): boolean {
  if (modifier === 'exact') return s === search;
  if (modifier === 'contains') return normalize(s).includes(normalize(search));
  return normalize(s).startsWith(normalize(search));
}

/** The strings a value is searched by: a HumanName's parts, an Address's */
function strings(item: Item): string[] {
  const val: any = item.v;
  const list = (...xs: unknown[]) =>
    xs.flat().filter((x): x is string => typeof x === 'string');
  switch (item.t) {
    case 'HumanName':
      return list(
        val?.text,
        val?.family,
        val?.given ?? [],
        val?.prefix ?? [],
        val?.suffix ?? [],
      );
    case 'Address':
      return list(
        val?.text,
        val?.line ?? [],
        val?.city,
        val?.district,
        val?.state,
        val?.postalCode,
        val?.country,
      );
  }
  return typeof val === 'string' ? [val] : [];
}

/* ------------------------------------------------------------------ */
/* Dates                                                              */
/* ------------------------------------------------------------------ */

/** The ranges a value covers: a date, dateTime or instant; a Period; a Timing's events */
function dateRanges(item: Item): [number, number][] {
  const val: any = item.v;
  const one = (x: unknown) =>
    typeof x === 'string' ? dateRange(x) : undefined;
  switch (item.t) {
    case 'Period': {
      const start = one(val?.start);
      const end = one(val?.end);
      if (!start && !end) return [];
      return [[start ? start[0] : -Infinity, end ? end[1] : Infinity]];
    }
    case 'Timing':
      return (val?.event ?? []).map(one).filter(Boolean) as [number, number][];
  }
  const r = one(val);
  return r ? [r] : [];
}

/** A value's prefix against the range of a target [t1, t2) */
function dateMatches(v: SearchValue, t1: number, t2: number): boolean {
  const s1 = v.start!;
  const s2 = v.end!;
  const eq = t1 >= s1 && t2 <= s2;
  switch (v.prefix ?? 'eq') {
    case 'eq':
      return eq;
    case 'ne':
      return !eq;
    case 'gt':
      return t2 > s2;
    case 'lt':
      return t1 < s1;
    case 'ge':
      return t2 > s2 || eq;
    case 'le':
      return t1 < s1 || eq;
    case 'sa':
      return t1 >= s2;
    case 'eb':
      return t2 <= s1;
    case 'ap': {
      // within 10% of the distance from now, as the specification suggests
      const margin = Math.abs(Date.now() - s1) * 0.1;
      return t1 < s2 + margin && t2 > s1 - margin;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Numbers and quantities                                             */
/* ------------------------------------------------------------------ */

/**
 * A number against a value: eq and ne by the value's precision (100 is
 * [99.5, 100.5)), the others by the number itself; ap within 10%
 */
function numberMatches(v: SearchValue, n: number): boolean {
  const x = v.number!;
  const eq = n >= v.start! && n < v.end!;
  switch (v.prefix ?? 'eq') {
    case 'eq':
      return eq;
    case 'ne':
      return !eq;
    case 'gt':
    case 'sa':
      return n > x;
    case 'lt':
    case 'eb':
      return n < x;
    case 'ge':
      return n >= x || eq;
    case 'le':
      return n <= x || eq;
    case 'ap':
      return Math.abs(n - x) <= Math.abs(x) * 0.1;
  }
  return false;
}

/** The kinds of FHIR Quantity, and Money (a value and a currency) */
const QUANTITIES = new Set([
  'Quantity',
  'Age',
  'Count',
  'Distance',
  'Duration',
  'SimpleQuantity',
  'MoneyQuantity',
  'Money',
]);

/**
 * A quantity against a value: its number as for a number; a system and code
 * given must be the quantity's; a code alone may be its code or its unit.
 * Units are not converted (5 mg does not find 0.005 g).
 */
function quantityMatches(item: Item, v: SearchValue): boolean {
  if (!QUANTITIES.has(item.t ?? '')) return false;
  const q: any = item.v;
  if (typeof q?.value !== 'number' || !numberMatches(v, q.value)) return false;
  if (item.t === 'Money')
    return v.code === undefined || (!v.system && q.currency === v.code);
  if (v.system)
    return q.system === v.system && (v.code === undefined || q.code === v.code);
  if (v.code !== undefined) return q.code === v.code || q.unit === v.code;
  return true;
}

/* ------------------------------------------------------------------ */
/* URIs                                                               */
/* ------------------------------------------------------------------ */

/** A URI as it is; :below finds those under it (by path), :above those it is under */
function uriMatches(
  item: Item,
  uri: string,
  modifier: string | undefined,
): boolean {
  const val = item.v;
  if (typeof val !== 'string') return false;
  const under = (u: string, base: string) =>
    u === base || u.startsWith(base.endsWith('/') ? base : base + '/');
  if (modifier === 'below') return under(val, uri);
  if (modifier === 'above') return under(uri, val);
  return val === uri;
}

/* ------------------------------------------------------------------ */
/* Sorting                                                            */
/* ------------------------------------------------------------------ */

/** What a value sorts by, for a parameter's type */
function sortKeys(type: string, item: Item): (number | string)[] {
  const val: any = item.v;
  switch (type) {
    case 'date':
      return dateRanges(item)
        .flatMap(([s, e]) => [s, e])
        .filter(Number.isFinite);
    case 'number':
      return typeof val === 'number' ? [val] : [];
    case 'quantity':
      return typeof val?.value === 'number' ? [val.value] : [];
    case 'string':
      return strings(item).map(normalize);
    case 'token': {
      const codes =
        item.t === 'CodeableConcept'
          ? (val?.coding ?? []).map((c: any) => c?.code)
          : item.t === 'Coding'
            ? [val?.code]
            : item.t === 'Identifier' || item.t === 'ContactPoint'
              ? [val?.value]
              : [val];
      return codes
        .filter(
          (c: unknown): c is string | number =>
            typeof c === 'string' || typeof c === 'number',
        )
        .map(String);
    }
    case 'reference':
      return item.t === 'Reference' && typeof val?.reference === 'string'
        ? [val.reference]
        : typeof val === 'string'
          ? [val]
          : [];
    case 'uri':
      return typeof val === 'string' ? [val] : [];
  }
  return [];
}
