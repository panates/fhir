/*
 * FHIR decimals keep the precision they are written with: 1.50 is not 1.5.
 * A JavaScript number cannot hold that, so the model keeps the number and,
 * next to it, the text it was read from: a non-enumerable property of the
 * object (or array) holding the value, by key. The text counts only while it
 * still reads as the number, so a value changed in code drops it.
 */

/** Where an object keeps the source text of its decimal values, by key */
export const DECIMAL_TEXT = Symbol.for('fhir.decimalText');

const DECIMAL_PATTERN = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

/**
 * Text a number may be written with that String(number) does not give back:
 * a trailing zero (1.50), an exponent (1e2), more digits than a double holds
 */
const LOSSY_NUMBER =
  /[:[,]\s*-?(?:[0-9]+\.[0-9]*0|[0-9]+(?:\.[0-9]+)?[eE][+-]?[0-9]+|(?=[0-9.]{16,}\s*[,\]}])[0-9]+(?:\.[0-9]+)?)\s*[,\]}]/;

const hasRawJSON = typeof (JSON as any).rawJSON === 'function';

/** Records the text of a decimal value */
export function markDecimalText(
  holder: object,
  key: string | number,
  text: string,
): void {
  let map = (holder as any)[DECIMAL_TEXT] as Record<string, string> | undefined;
  if (!map) {
    map = Object.create(null) as Record<string, string>;
    Object.defineProperty(holder, DECIMAL_TEXT, { value: map, configurable: true });
  }
  map[key] = text;
}

/**
 * The text a decimal value was written with (1.50), while the value is still
 * that number; undefined otherwise
 */
export function getDecimalText(
  holder: object,
  key: string | number,
): string | undefined {
  const text = (holder as any)[DECIMAL_TEXT]?.[key];
  if (text === undefined) return;
  return Number(text) === (holder as any)[key] ? text : undefined;
}

/**
 * Sets a decimal value from its text, keeping its precision:
 * setDecimal(quantity, 'value', '1.50')
 */
export function setDecimal(
  holder: object,
  key: string | number,
  text: string,
): void {
  if (!DECIMAL_PATTERN.test(text))
    throw new TypeError(`"${text}" is not a valid decimal`);
  (holder as any)[key] = Number(text);
  markDecimalText(holder, key, text);
}

/**
 * JSON.parse that keeps the source text of numbers String(number) would not
 * give back (1.50, 1e2). Uses the reviver's source text (Node 21+) only
 * when the text has such a number.
 */
export function parseFhirJson(text: string): any {
  if (!LOSSY_NUMBER.test(text)) return JSON.parse(text);
  return JSON.parse(text, function (this: any, key, value, context?: { source?: string }) {
    if (typeof value === 'number' && context?.source !== undefined) {
      const source = context.source;
      if (source !== String(value)) markDecimalText(this, key, source);
    }
    return value;
  });
}

/** The value to write for a decimal: its text when kept and rawJSON is there */
export function rawDecimal(value: number, text: string | undefined): unknown {
  return text !== undefined && hasRawJSON ? (JSON as any).rawJSON(text) : value;
}
