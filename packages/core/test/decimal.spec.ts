import { expect } from 'expect';
import {
  DECIMAL_TEXT,
  getDecimalText,
  parseFhirJson,
  rawDecimal,
  setDecimal,
} from '../src/index.js';

describe('decimal precision', () => {
  it('parseFhirJson keeps the text of numbers JSON.parse would change', () => {
    const o = parseFhirJson('{"a":1.50,"b":[2.0,3],"c":1.5E1,"d":7,"e":0.25}');
    expect(o).toEqual({ a: 1.5, b: [2, 3], c: 15, d: 7, e: 0.25 });
    expect(getDecimalText(o, 'a')).toBe('1.50');
    expect(getDecimalText(o.b, 0)).toBe('2.0');
    expect(getDecimalText(o.b, 1)).toBeUndefined();
    expect(getDecimalText(o, 'c')).toBe('1.5E1');
    expect(getDecimalText(o, 'd')).toBeUndefined();
  });

  it('keeps the text out of sight: not enumerable, not in JSON', () => {
    const o = parseFhirJson('{"a":1.50}');
    expect(Object.keys(o)).toEqual(['a']);
    expect(JSON.stringify(o)).toBe('{"a":1.5}');
    expect(Object.getOwnPropertyDescriptor(o, DECIMAL_TEXT)?.enumerable).toBe(
      false,
    );
  });

  it('keeps numbers with more digits than a double holds', () => {
    const o = parseFhirJson('{"a":66.899999999999991,"b":[12345678901234567]}');
    expect(getDecimalText(o, 'a')).toBe('66.899999999999991');
    expect(getDecimalText(o.b, 0)).toBe('12345678901234567');
  });

  it('does not run the reviver for digits inside strings (OIDs, versions)', () => {
    const o = parseFhirJson(
      '{"system":"urn:oid:1.2.36.146.595.217.0.1","v":"4.0.1"}',
    );
    expect((o as any)[DECIMAL_TEXT]).toBeUndefined();
  });

  it('drops the text once the value is changed', () => {
    const o = parseFhirJson('{"a":1.50}');
    o.a = 2;
    expect(getDecimalText(o, 'a')).toBeUndefined();
  });

  it('setDecimal sets a value with its precision, and checks it', () => {
    const q: any = {};
    setDecimal(q, 'value', '2.50');
    expect(q.value).toBe(2.5);
    expect(getDecimalText(q, 'value')).toBe('2.50');
    expect(() => setDecimal(q, 'value', '2,5')).toThrow(
      '"2,5" is not a valid decimal',
    );
  });

  it('rawDecimal writes the kept text with JSON.rawJSON', () => {
    expect(JSON.stringify({ v: rawDecimal(1.5, '1.50') })).toBe('{"v":1.50}');
    expect(rawDecimal(1.5, undefined)).toBe(1.5);
  });
});
