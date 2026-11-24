/*
 * The FHIRPath lexer (FHIRPath N1 / 2.0 grammar, hl7.org/fhirpath). Turns an
 * expression into tokens with their positions.
 */

export type TokenKind =
  | 'identifier' // name, or `delimited name`
  | 'string' // 'text'
  | 'number' // 12, 1.5
  | 'date' // @2024-05-01, @2024-05-01T10:00, @T10:00
  | 'variable' // $this, %resource, %'vs-name', %`x`
  | 'op' // . , ( ) [ ] { } + - * / & | = != ~ !~ < <= > >=
  | 'eof';

export interface Token {
  kind: TokenKind;
  /** The value: name without backticks, text without quotes, the operator */
  value: string;
  /** Position in the expression */
  start: number;
  end: number;
  /** A delimited identifier (`div`): never a keyword */
  delimited?: boolean;
}

/** A syntax error, with where it is */
export class FhirPathSyntaxError extends SyntaxError {
  constructor(
    message: string,
    readonly expression: string,
    readonly position: number,
  ) {
    super(
      `${message} at ${position + 1}: ${expression.length > 80 ? expression.slice(0, 80) + '…' : expression}`,
    );
    this.name = 'FhirPathSyntaxError';
  }
}

const TWO_CHAR_OPS = new Set(['!=', '!~', '<=', '>=']);
const ONE_CHAR_OPS = new Set([
  '.',
  ',',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '+',
  '-',
  '*',
  '/',
  '&',
  '|',
  '=',
  '~',
  '<',
  '>',
]);

const ESCAPES: Record<string, string> = {
  "'": "'",
  '"': '"',
  '`': '`',
  '\\': '\\',
  '/': '/',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdentStart = (c: string) =>
  (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c);

/** The tokens of an expression, ending with an 'eof' token */
export function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  const src = expression;
  const n = src.length;
  let i = 0;

  const fail = (message: string, at = i): never => {
    throw new FhirPathSyntaxError(message, src, at);
  };

  /** A quoted text from i (on the opening quote); returns its value */
  const quoted = (quote: string): string => {
    const start = i;
    let out = '';
    i++;
    while (i < n) {
      const c = src[i];
      if (c === quote) {
        i++;
        return out;
      }
      if (c === '\\') {
        const e = src[i + 1];
        if (e === 'u') {
          const hex = src.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('Invalid \\u escape', i);
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        if (e === undefined || !(e in ESCAPES))
          fail(`Invalid escape \\${e ?? ''}`, i);
        out += ESCAPES[e];
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return fail(
      `Unterminated ${quote === '`' ? 'identifier' : 'string'}`,
      start,
    );
  };

  while (i < n) {
    const c = src[i];
    // whitespace and comments
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) fail('Unterminated comment');
      i = end + 2;
      continue;
    }
    const start = i;

    if (isIdentStart(c)) {
      while (i < n && isIdentPart(src[i])) i++;
      tokens.push({
        kind: 'identifier',
        value: src.slice(start, i),
        start,
        end: i,
      });
      continue;
    }
    if (c === '`') {
      const value = quoted('`');
      tokens.push({
        kind: 'identifier',
        value,
        start,
        end: i,
        delimited: true,
      });
      continue;
    }
    // a string; "double quoted" is not FHIRPath, but an R4 invariant (eld-11) has one
    if (c === "'" || c === '"') {
      const value = quoted(c);
      tokens.push({ kind: 'string', value, start, end: i });
      continue;
    }
    if (isDigit(c)) {
      while (i < n && isDigit(src[i])) i++;
      // a decimal point only when a digit follows: 1.toString() is 1 . toString()
      if (src[i] === '.' && isDigit(src[i + 1] ?? '')) {
        i++;
        while (i < n && isDigit(src[i])) i++;
      }
      tokens.push({
        kind: 'number',
        value: src.slice(start, i),
        start,
        end: i,
      });
      continue;
    }
    if (c === '@') {
      // a time is hh[:mm[:ss[.fff]]]: a dot after it ends the literal (@T10:30.precision())
      const TIME = '[0-9]{2}(?::[0-9]{2}(?::[0-9]{2}(?:\\.[0-9]+)?)?)?';
      const m = new RegExp(
        `^@(?:T${TIME}|[0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?(?:T(?:${TIME})?(?:Z|[+-][0-9]{2}:[0-9]{2})?)?)`,
      ).exec(src.slice(i));
      if (!m || m[0].length === 1) fail('Invalid date/time literal');
      i += m![0].length;
      tokens.push({ kind: 'date', value: m![0].slice(1), start, end: i });
      continue;
    }
    if (c === '$') {
      i++;
      while (i < n && isIdentPart(src[i])) i++;
      const name = src.slice(start, i);
      if (name.length === 1) fail('Expected a name after $', start);
      tokens.push({ kind: 'variable', value: name, start, end: i });
      continue;
    }
    if (c === '%') {
      i++;
      let name: string;
      if (src[i] === '`') name = quoted('`');
      else if (src[i] === "'") name = quoted("'");
      else {
        const s = i;
        while (i < n && isIdentPart(src[i])) i++;
        name = src.slice(s, i);
        if (!name) fail('Expected a name after %', start);
      }
      tokens.push({ kind: 'variable', value: '%' + name, start, end: i });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      i += 2;
      tokens.push({ kind: 'op', value: two, start, end: i });
      continue;
    }
    if (ONE_CHAR_OPS.has(c)) {
      i++;
      tokens.push({ kind: 'op', value: c, start, end: i });
      continue;
    }
    fail(`Unexpected character "${c}"`);
  }
  tokens.push({ kind: 'eof', value: '', start: n, end: n });
  return tokens;
}
