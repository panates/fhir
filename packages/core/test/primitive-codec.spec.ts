import { expect } from 'expect';
import type { Validator } from 'valgen';
import {
  type FhirTypeInfo,
  isBase64,
  primitiveCodec,
  toFhirIssues,
  xsdToJsRegex,
} from '../src/index.js';

/** A primitive type as the model gives it */
function primitive(
  name: string,
  json: 'string' | 'number' | 'boolean',
  regex?: string,
): FhirTypeInfo {
  return { name, json, regex, kind: 'primitive-type' } as FhirTypeInfo;
}

function run(fn: Validator, value: unknown) {
  const r = fn.silent(value);
  return { out: r.value, issues: (r.errors || []).map(i => i.message) };
}

describe('primitiveCodec', () => {
  it('takes a JSON boolean only', () => {
    const fn = primitiveCodec(primitive('boolean', 'boolean'), 'decode');
    expect(run(fn, true)).toEqual({ out: true, issues: [] });
    expect(run(fn, 'true').issues).toEqual([
      'A boolean must be a JSON boolean',
    ]);
  });

  it('checks 32-bit integer ranges', () => {
    const integer = primitiveCodec(primitive('integer', 'number'), 'decode');
    const positive = primitiveCodec(
      primitive('positiveInt', 'number'),
      'decode',
    );
    const unsigned = primitiveCodec(
      primitive('unsignedInt', 'number'),
      'decode',
    );
    expect(run(integer, -5).out).toBe(-5);
    expect(run(integer, 1.5).issues).toEqual(['A integer must be an integer']);
    expect(run(integer, 2 ** 31).issues).toEqual([
      'A integer must be between -2147483648 and 2147483647',
    ]);
    expect(run(positive, 0).issues).toEqual([
      'A positiveInt must be between 1 and 2147483647',
    ]);
    expect(run(unsigned, 0).out).toBe(0);
  });

  it('takes a finite decimal', () => {
    const fn = primitiveCodec(primitive('decimal', 'number'), 'decode');
    expect(run(fn, 1.25).out).toBe(1.25);
    expect(run(fn, Number.NaN).issues).toEqual([
      'A decimal must be a JSON number',
    ]);
    expect(run(fn, '1.5').issues).toEqual(['A decimal must be a JSON number']);
  });

  it('rejects empty strings and checks the regex', () => {
    const fn = primitiveCodec(
      primitive('code', 'string', '[^\\s]+(\\s[^\\s]+)*'),
      'decode',
    );
    expect(run(fn, 'final').out).toBe('final');
    expect(run(fn, '').issues).toEqual(['A code must not be empty']);
    expect(run(fn, 'a  b').issues).toEqual(['"a  b" is not a valid code']);
  });

  it('takes null only when nullable (an item paired with _x)', () => {
    const def = primitive('string', 'string');
    expect(run(primitiveCodec(def, 'decode'), null).issues).toEqual([
      'A string must be a JSON string',
    ]);
    expect(run(primitiveCodec(def, 'decode', true), null)).toEqual({
      out: null,
      issues: [],
    });
  });

  it('encodes a Date as date, dateTime or instant', () => {
    const d = new Date(Date.UTC(2026, 10, 20, 9, 30));
    const enc = (name: string) =>
      primitiveCodec(primitive(name, 'string'), 'encode')(d);
    expect(enc('date')).toBe('2026-11-20');
    expect(enc('dateTime')).toBe('2026-11-20T09:30:00.000Z');
    expect(enc('instant')).toBe('2026-11-20T09:30:00.000Z');
    expect(
      run(primitiveCodec(primitive('date', 'string'), 'decode'), d).issues,
    ).toEqual(['A date must be a JSON string']);
  });
});

describe('xsdToJsRegex', () => {
  it('limits \\s to space, tab, CR and LF, as XML Schema does', () => {
    const string = new RegExp(`^(?:${xsdToJsRegex('[ \\r\\n\\t\\S]+')})$`);
    expect(string.test(' Seul')).toBe(true); // a no-break space is not \s in XML Schema
    expect(new RegExp('^(?:[ \\r\\n\\t\\S]+)$').test(' Seul')).toBe(false);
    const code = new RegExp(`^(?:${xsdToJsRegex('[^\\s]+(\\s[^\\s]+)*')})$`);
    expect(code.test('CHEST ')).toBe(true);
    expect(code.test('a b')).toBe(true);
    expect(code.test('a  b')).toBe(true);
    expect(code.test('a  b')).toBe(false);
  });
});

describe('toFhirIssues', () => {
  it('writes valgen issues as OperationOutcome issues, once each', () => {
    const issue = {
      message: 'x',
      rule: 'fhir:string',
      value: 1,
      location: 'name[0].given[1]',
      fhirCode: 'value',
    };
    expect(
      toFhirIssues(
        [
          issue,
          { ...issue },
          { ...issue, location: '[2]', fhirCode: undefined },
        ],
        'Patient',
      ),
    ).toEqual([
      {
        severity: 'error',
        code: 'value',
        expression: 'Patient.name[0].given[1]',
        diagnostics: 'x',
      },
      {
        severity: 'error',
        code: 'structure',
        expression: 'Patient[2]',
        diagnostics: 'x',
      },
    ]);
  });

  it('reads base64Binary in one pass, as its regex does, and of any size', () => {
    const re = new RegExp(
      `^(?:${xsdToJsRegex('(\\s*([0-9a-zA-Z\\+/=]){4}\\s*)+')})$`,
    );
    for (const s of [
      'dGVzdA==',
      'dGVz dA==',
      ' dGVz\ndA== ',
      'dGV zdA==',
      'dGVzdA=',
      'dG%zdA==',
      '',
      '   ',
      'ab+/',
    ])
      expect([s, isBase64(s)]).toEqual([s, re.test(s)]);
    // 4.6 MB, as R4B's Library-FHIR-ModelInfo: the regex overflows the stack
    expect(isBase64('QUJD'.repeat(1_200_000))).toBe(true);
  });
});
