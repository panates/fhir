import { expect } from 'expect';
import {
  type FhirPathNode,
  FhirPathSyntaxError,
  parse,
  tokenize,
} from '../src/index.js';

/** A tree as text, for short assertions: (op left right), name(args) */
function show(n: FhirPathNode): string {
  switch (n.kind) {
    case 'literal':
      return n.literal.type === 'empty'
        ? '{}'
        : 'value' in n.literal
          ? JSON.stringify(n.literal.value) +
            (n.literal.type === 'quantity' ? n.literal.unit : '')
          : '@' + n.literal.text;
    case 'identifier':
      return n.name;
    case 'variable':
      return n.name;
    case 'member':
      return `${show(n.target)}.${n.name}`;
    case 'function':
      return `${n.target ? show(n.target) + '.' : ''}${n.name}(${n.args.map(show).join(', ')})`;
    case 'index':
      return `${show(n.target)}[${show(n.index)}]`;
    case 'unary':
      return `(${n.op}${show(n.operand)})`;
    case 'typeop':
      return `(${show(n.operand)} ${n.op} ${n.typeName})`;
    case 'binary':
      return `(${show(n.left)} ${n.op} ${show(n.right)})`;
  }
}

describe('FHIRPath parser', () => {
  it('reads the tokens of an expression, with positions', () => {
    const t = tokenize("Patient.name.where(use = 'official') // a comment");
    expect(t.map(x => `${x.kind}:${x.value}`)).toEqual([
      'identifier:Patient',
      'op:.',
      'identifier:name',
      'op:.',
      'identifier:where',
      'op:(',
      'identifier:use',
      'op:=',
      'string:official',
      'op:)',
      'eof:',
    ]);
    expect(t[8]).toMatchObject({ start: 25, end: 35 });
  });

  it('reads literals: strings with escapes, numbers, dates, quantities, delimited names', () => {
    expect(show(parse("'it\\'s\\u00e7'"))).toBe('"it\'sç"');
    expect(show(parse('1.50'))).toBe('1.5');
    expect(parse('1.50')).toMatchObject({
      literal: { type: 'decimal', text: '1.50' },
    });
    expect(show(parse('@2024-05-01T10:00:00Z'))).toBe('@2024-05-01T10:00:00Z');
    expect(parse('@T10:30')).toMatchObject({
      literal: { type: 'time', text: '10:30' },
    });
    expect(show(parse("5 'mg'"))).toBe('5mg');
    expect(show(parse('3 days'))).toBe('3days');
    expect(show(parse('text.`div`'))).toBe('text.div');
    expect(show(parse('%`vs-administrative-gender`'))).toBe(
      '%vs-administrative-gender',
    );
  });

  it("applies the specification's precedence, left to right", () => {
    expect(show(parse('a or b and c implies d'))).toBe(
      '((a or (b and c)) implies d)',
    );
    expect(show(parse('a = b or c != d'))).toBe('((a = b) or (c != d))');
    expect(show(parse('1 + 2 * 3 - 4'))).toBe('((1 + (2 * 3)) - 4)');
    expect(show(parse('a | b = c'))).toBe('((a | b) = c)');
    expect(show(parse('-x.y[0]'))).toBe('(-x.y[0])');
    expect(
      show(parse('value is Quantity and (value as Quantity).value > 5')),
    ).toBe('((value is Quantity) and ((value as Quantity).value > 5))');
    expect(show(parse('a in b and c contains d'))).toBe(
      '((a in b) and (c contains d))',
    );
  });

  it('reads function calls with and without a target', () => {
    expect(show(parse("name.where(use = 'x').given.first()"))).toBe(
      'name.where((use = "x")).given.first()',
    );
    expect(show(parse('exists()'))).toBe('exists()');
    expect(show(parse('iif(a, b, c)'))).toBe('iif(a, b, c)');
    expect(show(parse('x.ofType(FHIR.string)'))).toBe('x.ofType(FHIR.string)');
  });

  it('reports where an expression is wrong', () => {
    const at = (e: string) => {
      try {
        parse(e);
      } catch (x) {
        if (x instanceof FhirPathSyntaxError)
          return `${x.position}: ${x.message.split(' at ')[0]}`;
        throw x;
      }
      return 'no error';
    };
    expect(at('a.')).toBe('2: Expected a name after "."');
    expect(at('a.b(')).toBe('4: The expression ended early');
    expect(at('a[1')).toBe('3: Expected "]", the expression ended');
    expect(at("'abc")).toBe('0: Unterminated string');
    expect(at('a ~ ~ b')).toBe('4: Unexpected "~"');
    expect(at('a # b')).toBe('2: Unexpected character "#"');
  });
});
