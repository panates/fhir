import type { BinaryOp, FhirPathNode, LiteralValue } from './ast.js';
import { FhirPathSyntaxError, type Token, tokenize } from './lexer.js';

/*
 * A Pratt parser for FHIRPath. Operator precedence, from the specification
 * (higher binds tighter); every binary operator is left-associative.
 */
const BINARY: Record<string, number> = {
  implies: 1,
  or: 2,
  xor: 2,
  and: 3,
  in: 4,
  contains: 4,
  '=': 5,
  '~': 5,
  '!=': 5,
  '!~': 5,
  '<': 6,
  '>': 6,
  '<=': 6,
  '>=': 6,
  '|': 7,
  is: 8,
  as: 8,
  '+': 9,
  '-': 9,
  '&': 9,
  '*': 10,
  '/': 10,
  div: 10,
  mod: 10,
};
const UNARY_BP = 11;
const POSTFIX_BP = 12;

/** Calendar duration units a number may take: 3 days, 1 year */
const CALENDAR_UNITS = new Set([
  'year',
  'years',
  'month',
  'months',
  'week',
  'weeks',
  'day',
  'days',
  'hour',
  'hours',
  'minute',
  'minutes',
  'second',
  'seconds',
  'millisecond',
  'milliseconds',
]);

/** Parses an expression into its syntax tree. Throws FhirPathSyntaxError. */
export function parse(expression: string): FhirPathNode {
  const tokens = tokenize(expression);
  let pos = 0;

  const peek = (o = 0): Token => tokens[Math.min(pos + o, tokens.length - 1)];
  const next = (): Token => tokens[pos++];
  const fail = (message: string, tok = peek()): never => {
    throw new FhirPathSyntaxError(message, expression, tok.start);
  };
  const isOp = (tok: Token, v: string) => tok.kind === 'op' && tok.value === v;
  const expectOp = (v: string): Token => {
    const t = peek();
    if (!isOp(t, v))
      fail(
        t.kind === 'eof'
          ? `Expected "${v}", the expression ended`
          : `Expected "${v}", found "${t.value}"`,
      );
    return next();
  };

  /** The binding power of the token as an infix operator, or 0 */
  const infixPower = (t: Token): number => {
    if (t.kind === 'op')
      return t.value === '.' || t.value === '['
        ? POSTFIX_BP
        : (BINARY[t.value] ?? 0);
    if (t.kind === 'identifier' && !t.delimited) return BINARY[t.value] ?? 0;
    return 0;
  };

  const typeSpecifier = (): string => {
    const t = next();
    if (t.kind !== 'identifier') fail('Expected a type name', t);
    let name = t.value;
    if (isOp(peek(), '.') && peek(1).kind === 'identifier') {
      next();
      name += '.' + next().value;
    }
    return name;
  };

  const args = (): FhirPathNode[] => {
    expectOp('(');
    const out: FhirPathNode[] = [];
    if (!isOp(peek(), ')')) {
      for (;;) {
        out.push(expr(0));
        if (isOp(peek(), ',')) {
          next();
          continue;
        }
        break;
      }
    }
    expectOp(')');
    return out;
  };

  const term = (): FhirPathNode => {
    const t = next();
    const start = t.start;
    switch (t.kind) {
      case 'identifier': {
        if (isOp(peek(), '(')) {
          const a = args();
          return {
            kind: 'function',
            name: t.value,
            args: a,
            start,
            end: tokens[pos - 1].end,
          };
        }
        if (!t.delimited && (t.value === 'true' || t.value === 'false'))
          return {
            kind: 'literal',
            literal: { type: 'boolean', value: t.value === 'true' },
            start,
            end: t.end,
          };
        return { kind: 'identifier', name: t.value, start, end: t.end };
      }
      case 'string':
        return {
          kind: 'literal',
          literal: { type: 'string', value: t.value },
          start,
          end: t.end,
        };
      case 'number': {
        const u = peek();
        // a quantity: 5 'mg', 3 days
        if (
          u.kind === 'string' ||
          (u.kind === 'identifier' &&
            !u.delimited &&
            CALENDAR_UNITS.has(u.value))
        ) {
          next();
          const literal: LiteralValue = {
            type: 'quantity',
            value: Number(t.value),
            text: t.value,
            unit: u.value,
          };
          return { kind: 'literal', literal, start, end: u.end };
        }
        const literal: LiteralValue = t.value.includes('.')
          ? { type: 'decimal', value: Number(t.value), text: t.value }
          : { type: 'integer', value: Number(t.value) };
        return { kind: 'literal', literal, start, end: t.end };
      }
      case 'date': {
        const text = t.value;
        const type = text.startsWith('T')
          ? 'time'
          : text.includes('T')
            ? 'dateTime'
            : 'date';
        return {
          kind: 'literal',
          literal: { type, text: type === 'time' ? text.slice(1) : text },
          start,
          end: t.end,
        };
      }
      case 'variable':
        return { kind: 'variable', name: t.value, start, end: t.end };
      case 'op':
        if (t.value === '(') {
          const e = expr(0);
          expectOp(')');
          // the parentheses are part of it: (a + b) * c spans from "("
          return { ...e, start, end: tokens[pos - 1].end };
        }
        if (t.value === '{') {
          expectOp('}');
          return {
            kind: 'literal',
            literal: { type: 'empty' },
            start,
            end: tokens[pos - 1].end,
          };
        }
        if (t.value === '+' || t.value === '-') {
          const operand = expr(UNARY_BP);
          return {
            kind: 'unary',
            op: t.value,
            operand,
            start,
            end: operand.end,
          };
        }
        break;
      case 'eof':
        return fail('The expression ended early', t);
    }
    return fail(`Unexpected "${t.value}"`, t);
  };

  const expr = (minPower: number): FhirPathNode => {
    let left = term();
    for (;;) {
      const t = peek();
      const power = infixPower(t);
      if (power <= minPower) break;
      next();
      if (t.kind === 'op' && t.value === '.') {
        const name = next();
        if (name.kind !== 'identifier') fail('Expected a name after "."', name);
        if (isOp(peek(), '(')) {
          const a = args();
          left = {
            kind: 'function',
            target: left,
            name: name.value,
            args: a,
            start: left.start,
            end: tokens[pos - 1].end,
          };
        } else
          left = {
            kind: 'member',
            target: left,
            name: name.value,
            start: left.start,
            end: name.end,
          };
        continue;
      }
      if (t.kind === 'op' && t.value === '[') {
        const index = expr(0);
        const close = expectOp(']');
        left = {
          kind: 'index',
          target: left,
          index,
          start: left.start,
          end: close.end,
        };
        continue;
      }
      if (t.value === 'is' || t.value === 'as') {
        const typeName = typeSpecifier();
        left = {
          kind: 'typeop',
          op: t.value,
          operand: left,
          typeName,
          start: left.start,
          end: tokens[pos - 1].end,
        };
        continue;
      }
      const right = expr(power);
      left = {
        kind: 'binary',
        op: t.value as BinaryOp,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  };

  const tree = expr(0);
  if (peek().kind !== 'eof') fail(`Unexpected "${peek().value}"`);
  return tree;
}
