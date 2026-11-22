import type { FhirSearchParameter, FhirSearchParamType } from '@fhirjs/core';
import { FhirServerError } from './fhir-server-error.js';

/** The prefix of a date, number or quantity value */
export type SearchPrefix =
  'eq' | 'ne' | 'lt' | 'gt' | 'le' | 'ge' | 'sa' | 'eb' | 'ap';

/** One value of a criterion, parsed for its parameter's type */
export interface SearchValue {
  /** As written in the URL, escapes removed */
  raw: string;
  /** date, number, quantity: the comparison (eq when not written) */
  prefix?: SearchPrefix;
  /**
   * token: the system before '|'; '' for '|code' (no system); undefined when
   * no '|'. quantity: the unit's system; '' or undefined for any.
   */
  system?: string;
  /** token: the code (or identifier value); undefined for 'system|'. quantity: the unit's code */
  code?: string;
  /**
   * date: the instants the value covers, [start, end) in milliseconds.
   * number, quantity: the numbers it covers by its precision (100 is
   * [99.5, 100.5)), with the number itself in `number`.
   */
  start?: number;
  end?: number;
  number?: number;
  /** uri: the URI */
  uri?: string;
  /** reference: the type, when given ('Patient/1', or the :Patient modifier) */
  type?: string;
  /** reference: the id; or the whole URL of an absolute reference in `url` */
  id?: string;
  url?: string;
}

/** A search parameter with its values: a resource matches when one of the values does (OR) */
export interface SearchCriterion {
  param: FhirSearchParameter;
  /** :exact, :contains, :missing, :not, :text, or a resource type for a reference */
  modifier?: string;
  /** :missing: true or false */
  missing?: boolean;
  values: SearchValue[];
}

/** A parsed search: a resource matches when it matches every criterion (AND) */
export interface SearchQuery {
  type: string;
  criteria: SearchCriterion[];
  /** _count */
  count: number;
  /** The matches to skip, for the next page */
  offset: number;
  /** _sort: the parameters to order by, the first first; none for the store's own order */
  sort: SearchSort[];
  /**
   * Whether a resource (in its JSON form) matches every criterion, by the
   * FHIRPath expressions of the parameters. A store that searches a database
   * translates the criteria instead; the memory store calls this.
   */
  matches(resource: Record<string, any>): boolean;
  /** The order of two resources by `sort`, by FHIRPath, as for matches() */
  compare(a: Record<string, any>, b: Record<string, any>): number;
}

/** A parameter to sort by */
export interface SearchSort {
  param: FhirSearchParameter;
  /** _sort=-date */
  descending: boolean;
}

/** The parameter types the server parses */
export const SEARCH_TYPES: ReadonlySet<FhirSearchParamType> = new Set([
  'token',
  'string',
  'date',
  'reference',
  'number',
  'quantity',
  'uri',
]);

/** The modifiers each type takes (a reference also takes a resource type) */
const MODIFIERS: Record<string, ReadonlySet<string>> = {
  string: new Set(['exact', 'contains', 'missing']),
  token: new Set(['not', 'text', 'missing']),
  date: new Set(['missing']),
  reference: new Set(['missing']),
  number: new Set(['missing']),
  quantity: new Set(['missing']),
  uri: new Set(['below', 'above', 'missing']),
};

const PREFIXES = new Set([
  'eq',
  'ne',
  'lt',
  'gt',
  'le',
  'ge',
  'sa',
  'eb',
  'ap',
]);

/** Search parameters the server reads itself; they are not criteria */
export const RESULT_PARAMS = new Set(['_count', '_offset', '_format', '_sort']);

/** A prefix at the start of a value followed by a digit (or a sign), and the rest */
function prefixOf(raw: string): [SearchPrefix | undefined, string] {
  const p = raw.slice(0, 2);
  return PREFIXES.has(p) && /^[-+\d.]/.test(raw.slice(2))
    ? [p as SearchPrefix, raw.slice(2)]
    : [undefined, raw];
}

/**
 * A number and the range its precision gives: '100' is [99.5, 100.5),
 * '1.50' [1.495, 1.505), '1e2' [50, 150). Undefined when it is not a number.
 */
export function numberRange(
  text: string,
): [number, number, number] | undefined {
  const m = /^([+-]?)(\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m || (!m[2] && !m[3])) return;
  const n = Number(text);
  const half = 10 ** (Number(m[4] ?? 0) - (m[3]?.length ?? 0)) / 2;
  return [n - half, n + half, n];
}

/** Splits on the '|' that are not escaped, and removes the escapes */
function splitBars(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\' && i + 1 < raw.length) cur += raw[++i];
    else if (raw[i] === '|') {
      out.push(cur);
      cur = '';
    } else cur += raw[i];
  }
  out.push(cur);
  return out;
}

/** Splits a value on the commas that are not escaped, and removes the escapes */
export function splitValues(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      cur += text[++i];
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Splits a token on its first '|' that is not escaped */
function splitToken(raw: string): [string | undefined, string] {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') i++;
    else if (raw[i] === '|') return [raw.slice(0, i), raw.slice(i + 1)];
  }
  return [undefined, raw];
}

/** One parameter of a search URL, parsed against its definition; throws 400 for a value it cannot read */
export function parseCriterion(
  param: FhirSearchParameter,
  modifier: string | undefined,
  text: string,
  isResourceType: (name: string) => boolean,
): SearchCriterion {
  const c: SearchCriterion = { param, values: [] };
  if (modifier !== undefined) {
    const typeModifier = param.type === 'reference' && isResourceType(modifier);
    if (!typeModifier && !MODIFIERS[param.type]?.has(modifier))
      throw new FhirServerError(
        400,
        `${param.code}:${modifier}: the modifier is not supported`,
        'not-supported',
      );
    c.modifier = modifier;
  }
  if (modifier === 'missing') {
    if (text !== 'true' && text !== 'false')
      throw new FhirServerError(
        400,
        `${param.code}:missing takes true or false, not "${text}"`,
        'value',
      );
    c.missing = text === 'true';
    return c;
  }
  for (const raw of splitValues(text)) {
    if (raw === '')
      throw new FhirServerError(400, `${param.code}: an empty value`, 'value');
    c.values.push(parseValue(param, modifier, raw, isResourceType));
  }
  return c;
}

function parseValue(
  param: FhirSearchParameter,
  modifier: string | undefined,
  raw: string,
  isResourceType: (name: string) => boolean,
): SearchValue {
  const v: SearchValue = { raw };
  switch (param.type) {
    case 'token': {
      if (modifier === 'text') break;
      const [system, code] = splitToken(raw);
      if (system !== undefined) v.system = system.replace(/\\(.)/g, '$1');
      const c = code.replace(/\\(.)/g, '$1');
      if (c !== '') v.code = c;
      else if (system === undefined)
        throw new FhirServerError(
          400,
          `${param.code}: an empty token`,
          'value',
        );
      break;
    }
    case 'number':
    case 'quantity': {
      const [prefix, text] = prefixOf(raw);
      if (prefix) v.prefix = prefix;
      const [num, system, code] =
        param.type === 'quantity' ? splitBars(text) : [text];
      const range = numberRange(num);
      if (!range || (param.type === 'quantity' && splitBars(text).length > 3))
        throw new FhirServerError(
          400,
          `${param.code}: "${raw}" is not a ${param.type}`,
          'value',
        );
      [v.start, v.end, v.number] = range;
      if (system) v.system = system;
      if (code) v.code = code;
      break;
    }
    case 'uri':
      v.uri = raw;
      break;
    case 'date': {
      const [prefix, text] = prefixOf(raw);
      if (prefix) v.prefix = prefix;
      const range = dateRange(text);
      if (!range)
        throw new FhirServerError(
          400,
          `${param.code}: "${raw}" is not a date`,
          'value',
        );
      [v.start, v.end] = range;
      break;
    }
    case 'reference': {
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
        v.url = raw;
        const m =
          /\/([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/[^/]+)?$/.exec(
            raw,
          );
        if (m) [v.type, v.id] = [m[1], m[2]];
      } else {
        const m = /^(?:([A-Z][A-Za-z]+)\/)?([A-Za-z0-9\-.]{1,64})$/.exec(raw);
        if (!m || (m[1] && !isResourceType(m[1])))
          throw new FhirServerError(
            400,
            `${param.code}: "${raw}" is not a reference`,
            'value',
          );
        if (m[1]) v.type = m[1];
        v.id = m[2];
      }
      if (modifier && modifier !== 'missing') {
        if (v.type && v.type !== modifier)
          throw new FhirServerError(
            400,
            `${param.code}:${modifier}: "${raw}" is not a ${modifier}`,
            'value',
          );
        v.type = modifier;
      }
      if (v.type && param.target?.length && !param.target.includes(v.type))
        throw new FhirServerError(
          400,
          `${param.code}: a reference to ${param.target.join(', ')}, not ${v.type}`,
          'value',
        );
      break;
    }
  }
  return v;
}

/**
 * The instants a FHIR date or dateTime covers, [start, end) in milliseconds:
 * '2020' the whole year, '2020-03-04T10:00' that minute. A time without a
 * zone is read as UTC. Undefined when the text is not a date.
 */
export function dateRange(text: string): [number, number] | undefined {
  const m =
    /^(\d{4})(?:-(\d\d)(?:-(\d\d)(?:T(\d\d)(?::(\d\d)(?::(\d\d)(\.\d+)?)?)?(Z|[+-]\d\d:\d\d)?)?)?)?$/.exec(
      text,
    );
  if (!m) return;
  const [, y, mo, d, h, mi, s, frac, tz] = m;
  const parts = [
    Number(y),
    mo ? Number(mo) - 1 : 0,
    d ? Number(d) : 1,
    h ? Number(h) : 0,
    mi ? Number(mi) : 0,
    s ? Number(s) : 0,
  ];
  if (mo && (parts[1] < 0 || parts[1] > 11)) return;
  if (d && (parts[2] < 1 || parts[2] > 31)) return;
  if (h && (parts[3] > 23 || parts[4] > 59 || parts[5] > 59)) return;
  const ms = frac ? Math.round(Number(frac) * 1000) : 0;
  let offset = 0;
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    offset =
      sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(4, 6))) * 60000;
  }
  const at = (p: number[], extra = 0) =>
    Date.UTC(p[0], p[1], p[2], p[3], p[4], p[5], extra) - offset;
  const start = at(parts, ms);
  // the end: the next unit of the last part written
  const next = [...parts];
  let extra = ms;
  if (frac) extra = ms + 10 ** (3 - Math.min(3, frac.length - 1));
  else if (s) next[5]++;
  else if (mi) next[4]++;
  else if (h) next[3]++;
  else if (d) next[2]++;
  else if (mo) next[1]++;
  else next[0]++;
  const end = at(next, extra);
  // a day that does not exist (02-30) rolls over: refused
  if (
    d &&
    new Date(Date.UTC(parts[0], parts[1], parts[2])).getUTCDate() !== parts[2]
  )
    return;
  return [start, end];
}
