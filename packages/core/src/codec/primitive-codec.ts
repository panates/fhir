import { type Context, type Validator, validator } from 'valgen';
import type { FhirTypeInfo } from '../fhir-model.js';
import type { FhirCodecMode } from './types.js';

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** Integer types and their lowest value */
const INTEGER_MIN: Record<string, number> = {
  integer: INT32_MIN,
  unsignedInt: 0,
  positiveInt: 1,
};

/** Types whose value may be given as a Date when encoding */
const DATE_TYPES = new Set(['date', 'dateTime', 'instant']);

const VALUE = { fhirCode: 'value' };

/**
 * The codec of a primitive type, as a valgen validator: its JSON form, the
 * specification's regex, integer ranges. `nullable` admits null, for an item
 * of a primitive array whose `_x` entry holds its extensions.
 */
export function primitiveCodec(
  type: FhirTypeInfo,
  mode: FhirCodecMode,
  nullable = false,
): Validator {
  const name = type.name;
  const json = type.json || 'string';
  const re = type.regex
    ? new RegExp(`^(?:${xsdToJsRegex(type.regex)})$`)
    : undefined;
  // base64Binary's regex backtracks through every group: a value of some MB
  // overflows the stack. The same rule, read in one pass.
  const regex = name === 'base64Binary' && re ? { test: isBase64 } : re;
  const intMin = INTEGER_MIN[name];
  const acceptsDate = mode === 'encode' && DATE_TYPES.has(name);
  const id = 'fhir:' + name;

  if (json === 'boolean')
    return validator(id, (input: unknown, context: Context, _this) => {
      if (typeof input === 'boolean') return input;
      if (input === null && nullable) return null;
      context.fail(_this, `A ${name} must be a JSON boolean`, input, VALUE);
    });

  if (json === 'number')
    return validator(id, (input: unknown, context: Context, _this) => {
      if (typeof input !== 'number' || !Number.isFinite(input)) {
        if (input === null && nullable) return null;
        context.fail(_this, `A ${name} must be a JSON number`, input, VALUE);
        return;
      }
      if (intMin !== undefined) {
        if (!Number.isInteger(input)) {
          context.fail(_this, `A ${name} must be an integer`, input, VALUE);
          return;
        }
        if (input < intMin || input > INT32_MAX) {
          context.fail(
            _this,
            `A ${name} must be between ${intMin} and ${INT32_MAX}`,
            input,
            VALUE,
          );
          return;
        }
      }
      return input;
    });

  return validator(id, (input: unknown, context: Context, _this) => {
    let value = input;
    if (typeof value !== 'string') {
      if (value === null && nullable) return null;
      if (acceptsDate && value instanceof Date) value = dateToFhir(name, value);
      else {
        context.fail(_this, `A ${name} must be a JSON string`, input, VALUE);
        return;
      }
    }
    const s = value as string;
    if (!s) {
      context.fail(_this, `A ${name} must not be empty`, input, VALUE);
      return;
    }
    if (regex && !regex.test(s)) {
      context.fail(
        _this,
        `"${s.length > 40 ? s.slice(0, 40) + '…' : s}" is not a valid ${name}`,
        input,
        VALUE,
      );
      return;
    }
    return s;
  });
}

/**
 * base64Binary's rule, `(\s*([0-9a-zA-Z\+/=]){4}\s*)+`, in one pass: groups
 * of four of those characters, spaces only between groups
 */
export function isBase64(s: string): boolean {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      if (n % 4) return false;
      continue;
    }
    const ok =
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      c === 43 ||
      c === 47 ||
      c === 61;
    if (!ok) return false;
    n++;
  }
  return n > 0 && n % 4 === 0;
}

/** Unicode spaces JavaScript's \s takes and XML Schema's does not */
const NON_XSD_SPACES =
  '\\u000B\\u000C\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF';

/**
 * The specification's regexes follow XML Schema, where \s is only space, tab,
 * CR and LF. In JavaScript \s also takes other Unicode spaces (U+00A0 ...),
 * so a value starting with a no-break space would fail [ \r\n\t\S]+.
 */
export function xsdToJsRegex(src: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      const n = src[++i];
      if (n === 's') out += inClass ? ' \\t\\n\\r' : '[ \\t\\n\\r]';
      else if (n === 'S')
        out += inClass ? '\\S' + NON_XSD_SPACES : `[\\S${NON_XSD_SPACES}]`;
      else out += c + (n ?? '');
      continue;
    }
    if (c === '[' && !inClass) inClass = true;
    else if (c === ']' && inClass) inClass = false;
    out += c;
  }
  return out;
}

/** A Date as a date (UTC day), dateTime or instant */
function dateToFhir(type: string, d: Date): string {
  const iso = d.toISOString();
  return type === 'date' ? iso.slice(0, 10) : iso;
}
