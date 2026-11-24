import type { BinaryNode, FhirPathNode, LiteralValue } from './ast.js';
import {
  bool,
  chained,
  checkTypeName,
  EMPTY,
  type EvalContext,
  FALSE,
  type Fn,
  isOfType,
  KNOWN_VARS,
  navigate,
  toBool,
  TRUE,
  typeNameOf,
  union,
} from './context.js';
import { FUNCTIONS } from './functions.js';
import { canonical, unitOf } from './ucum.js';
import {
  decimalText,
  FhirPathError,
  FpQuantity,
  FpTemporal,
  Item,
  itemCompare,
  itemEquals,
  itemEquivalent,
  primitiveValue,
  quantityOf,
  quantityPair,
  round12,
  systemType,
  textPlaces,
  typeLabel,
} from './values.js';

/* ------------------------------------------------------------------ */
/* Compilation                                                        */
/* ------------------------------------------------------------------ */

function literalItems(l: LiteralValue): Item[] {
  switch (l.type) {
    case 'empty':
      return EMPTY;
    case 'boolean':
      return [new Item(l.value, 'System.Boolean')];
    case 'string':
      return [new Item(l.value, 'System.String')];
    case 'integer':
      return [new Item(l.value, 'System.Integer')];
    case 'decimal':
      return [new Item(l.value, 'System.Decimal', l.text)];
    case 'date':
      return [new Item(new FpTemporal('Date', l.text), 'System.Date')];
    case 'dateTime':
      return [new Item(new FpTemporal('DateTime', l.text), 'System.DateTime')];
    case 'time':
      return [new Item(new FpTemporal('Time', l.text), 'System.Time')];
    case 'quantity':
      return [
        new Item(new FpQuantity(l.value, l.unit, l.text), 'System.Quantity'),
      ];
  }
}

function variable(name: string): Fn {
  if (name === '$this') return ctx => ctx.focus;
  if (name === '$index')
    return ctx =>
      ctx.index === undefined ? EMPTY : [new Item(ctx.index, 'System.Integer')];
  if (name === '$total') return ctx => ctx.total ?? EMPTY;
  const key = name.slice(1);
  if (KNOWN_VARS[key]) {
    const items = [new Item(KNOWN_VARS[key], 'System.String')];
    return ctx => ctx.env.vars[key] ?? items;
  }
  // %`vs-name`, %`ext-name`: value sets and extensions of the specification
  if (key.startsWith('vs-') || key.startsWith('ext-')) {
    const url =
      (key.startsWith('vs-')
        ? 'http://hl7.org/fhir/ValueSet/'
        : 'http://hl7.org/fhir/StructureDefinition/') +
      key.slice(key.indexOf('-') + 1);
    const items = [new Item(url, 'System.String')];
    return ctx => ctx.env.vars[key] ?? items;
  }
  return ctx => {
    const v = ctx.scope?.[key] ?? ctx.env.vars[key];
    if (v === undefined) throw new FhirPathError(`Unknown variable ${name}`);
    return v;
  };
}

/** Compiles a syntax tree to a function of a context */
export function compile(node: FhirPathNode): Fn {
  switch (node.kind) {
    case 'literal': {
      const items = literalItems(node.literal);
      return () => items;
    }
    case 'variable':
      return variable(node.name);
    case 'identifier': {
      const name = node.name;
      const maybeType = name[0] >= 'A' && name[0] <= 'Z';
      return ctx => {
        const input = ctx.focus;
        // Patient.name: a type name at the start filters the input by type
        if (maybeType) {
          const typed = input.filter(i => isOfType(ctx.env, i, name));
          if (typed.length) return typed;
        }
        return navigate(ctx.env, input, name);
      };
    }
    case 'member': {
      const target = compile(node.target);
      const name = node.name;
      return ctx =>
        chained(ctx, target(ctx), (c, items) => navigate(c.env, items, name));
    }
    case 'index': {
      const target = compile(node.target);
      const index = compile(node.index);
      return ctx => {
        const i = index(ctx);
        if (!i.length) return EMPTY;
        const n = i[0].v;
        if (typeof n !== 'number' || !Number.isInteger(n))
          throw new FhirPathError('An index must be an Integer');
        return chained(ctx, target(ctx), (_c, items) =>
          n >= 0 && n < items.length ? [items[n]] : EMPTY,
        );
      };
    }
    case 'unary': {
      const operand = compile(node.operand);
      if (node.op === '+') return operand;
      return ctx =>
        operand(ctx).map(i => {
          const v = primitiveValue(i);
          if (typeof v === 'number') {
            // the digits written stay: -(1.50) is -1.50
            const t = decimalText(i);
            const x = t
              ? t.startsWith('-')
                ? t.slice(1)
                : '-' + t
              : undefined;
            return new Item(
              -v,
              i.t?.startsWith('System.') ? i.t : `System.${systemType(i)}`,
              x,
            );
          }
          if (v instanceof FpQuantity)
            return new Item(
              new FpQuantity(-v.value, v.unit),
              'System.Quantity',
            );
          throw new FhirPathError(`Cannot negate ${typeLabel(i)}`);
        });
    }
    case 'typeop': {
      const operand = compile(node.operand);
      const typeName = node.typeName;
      if (node.op === 'is')
        return ctx => {
          checkTypeName(ctx.env, typeName);
          const items = operand(ctx);
          if (!items.length) return EMPTY;
          if (items.length > 1)
            throw new FhirPathError(
              `"is" expects a single item, got ${items.length}`,
            );
          return bool(isOfType(ctx.env, items[0], typeName));
        };
      // as: on one item; lenient on collections (R4's dom-3 uses it on one)
      return ctx => {
        checkTypeName(ctx.env, typeName);
        const items = operand(ctx);
        if (items.length > 1 && !ctx.env.lenient)
          throw new FhirPathError(`"as" on ${items.length} items`);
        return items.filter(i => isOfType(ctx.env, i, typeName, true));
      };
    }
    case 'function': {
      // own names only: not constructor(), valueOf() ...
      const impl = Object.hasOwn(FUNCTIONS, node.name)
        ? FUNCTIONS[node.name]
        : undefined;
      if (!impl) throw new FhirPathError(`Unknown function ${node.name}()`);
      if (
        impl.arity &&
        (node.args.length < impl.arity[0] || node.args.length > impl.arity[1])
      )
        throw new FhirPathError(
          `${node.name}() takes ${impl.arity[0] === impl.arity[1] ? impl.arity[0] : impl.arity.join(' to ')} arguments, ${node.args.length} given`,
        );
      const target = node.target ? compile(node.target) : undefined;
      // sort(-key): a descending key; the minus is no negation (strings sort so too)
      const args = impl.typeArg
        ? []
        : node.args.map(a => {
            if (node.name !== 'sort' || a.kind !== 'unary' || a.op !== '-')
              return compile(a);
            const key = compile(a.operand);
            return Object.assign((c: EvalContext) => key(c), {
              descending: true,
            });
          });
      const typeArg =
        impl.typeArg && node.args[0] ? typeNameOf(node.args[0]) : undefined;
      if (!target) return ctx => impl.fn(ctx, ctx.focus, args, typeArg);
      return ctx =>
        chained(ctx, target(ctx), (c, items) =>
          impl.fn(c, items, args, typeArg),
        );
    }
    case 'binary':
      return binary(node);
  }
}

/* ------------------------------------------------------------------ */
/* Operators                                                          */
/* ------------------------------------------------------------------ */

function single(items: Item[], op: string): Item | undefined {
  if (!items.length) return;
  if (items.length > 1)
    throw new FhirPathError(
      `"${op}" expects a single item on each side, got ${items.length}`,
    );
  return items[0];
}

/** Decimal places of a number item as written (1.50 has 2) */
function placesOf(item: Item): number {
  return textPlaces(decimalText(item) ?? String(primitiveValue(item)));
}

/** A decimal result rounded to the places of its operands, kept as text */
function decimalItem(value: number, places: number): Item {
  const p = Math.min(places, 15);
  const text = value.toFixed(p);
  return new Item(Number(text), 'System.Decimal', text);
}

function arithmetic(op: string, a: Item, b: Item): Item[] {
  const av = primitiveValue(a);
  const bv = primitiveValue(b);
  const at = systemType(a);
  const bt = systemType(b);
  if (typeof av === 'number' && typeof bv === 'number') {
    const decimal = at === 'Decimal' || bt === 'Decimal';
    const pa = placesOf(a);
    const pb = placesOf(b);
    const num = (v: number, places: number) =>
      decimal ? [decimalItem(v, places)] : [new Item(v, 'System.Integer')];
    switch (op) {
      case '+':
        return num(av + bv, Math.max(pa, pb));
      case '-':
        return num(av - bv, Math.max(pa, pb));
      case '*':
        return num(av * bv, pa + pb);
      case '/':
        return bv === 0
          ? EMPTY
          : [new Item(round12(av / bv), 'System.Decimal')];
      case 'div':
        return bv === 0
          ? EMPTY
          : [new Item(Math.trunc(av / bv), 'System.Integer')];
      case 'mod':
        return bv === 0 ? EMPTY : num(av % bv, Math.max(pa, pb));
    }
  }
  if (op === '+' && typeof av === 'string' && typeof bv === 'string')
    return [new Item(av + bv, 'System.String')];
  if ((op === '+' || op === '-') && av instanceof FpTemporal) {
    const q = quantityOf(b) ?? (bv instanceof FpQuantity ? bv : undefined);
    if (q)
      return [
        new Item(addDuration(av, q, op === '-' ? -1 : 1), `System.${av.kind}`),
      ];
  }
  const aq = av instanceof FpQuantity ? av : quantityOf(a);
  const bq = bv instanceof FpQuantity ? bv : quantityOf(b);
  if (aq && bq && (op === '+' || op === '-')) {
    const p = quantityPair(aq, bq);
    if (!p)
      throw new FhirPathError(
        `Cannot ${op === '+' ? 'add' : 'subtract'} ${bq} ${op === '+' ? 'to' : 'from'} ${aq}`,
      );
    return [
      new Item(
        new FpQuantity(round12(op === '+' ? p.a + p.b : p.a - p.b), aq.unit),
        'System.Quantity',
      ),
    ];
  }
  if (aq && bq && (op === '*' || op === '/')) {
    const ca = canonical(aq.ucum ?? '');
    const cb = canonical(bq.ucum ?? '');
    if (!ca || !cb)
      throw new FhirPathError(
        `Cannot ${op === '*' ? 'multiply' : 'divide'} ${aq} and ${bq}`,
      );
    const dims: Record<string, number> = { ...ca.dims };
    for (const [k, v] of Object.entries(cb.dims)) {
      dims[k] = (dims[k] ?? 0) + (op === '*' ? v : -v);
      if (!dims[k]) delete dims[k];
    }
    const value =
      op === '*'
        ? aq.value * ca.factor * bq.value * cb.factor
        : (aq.value * ca.factor) / (bq.value * cb.factor);
    return [
      new Item(new FpQuantity(round12(value), unitOf(dims)), 'System.Quantity'),
    ];
  }
  if (aq && typeof bv === 'number' && (op === '*' || op === '/'))
    return [
      new Item(
        new FpQuantity(
          round12(op === '*' ? aq.value * bv : aq.value / bv),
          aq.unit,
        ),
        'System.Quantity',
      ),
    ];
  if (typeof av === 'number' && bq && op === '*')
    return [
      new Item(
        new FpQuantity(round12(av * bq.value), bq.unit),
        'System.Quantity',
      ),
    ];
  throw new FhirPathError(
    `Cannot apply "${op}" to ${typeLabel(a)} and ${typeLabel(b)}`,
  );
}

/** Calendar words and the UCUM units date arithmetic takes, by the part they change */
const DURATION_PART: Record<string, string> = {
  year: 'a',
  years: 'a',
  month: 'mo',
  months: 'mo',
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
  wk: 'wk',
  d: 'd',
  h: 'h',
  min: 'min',
  s: 's',
  ms: 'ms',
};

/** A date/time moved by a calendar duration, at its own precision */
function addDuration(t: FpTemporal, q: FpQuantity, sign: number): FpTemporal {
  // UCUM 'a' and 'mo' are not calendar years and months: not for dates
  const key = DURATION_PART[q.unit];
  if (!key)
    throw new FhirPathError(
      `Cannot add ${q} to a ${t.kind}: use a calendar duration (1 year, 1 month)`,
    );
  const p = t.kind === 'Time' ? [1970, 1, 1, ...t.parts] : [...t.parts];
  const sec = p[5] ?? 0;
  const d = new Date(
    Date.UTC(
      p[0],
      (p[1] ?? 1) - 1,
      p[2] ?? 1,
      p[3] ?? 0,
      p[4] ?? 0,
      Math.trunc(sec),
      Math.round((sec % 1) * 1000),
    ),
  );
  // milliseconds when the value had them (.000 stays)
  const hasFraction = /\d{2}:\d{2}:\d{2}\.\d+/.test(t.text);
  // above milliseconds, a decimal part is ignored; seconds keep it to the
  // millisecond when the value has milliseconds (+ 0.1 's')
  const n = Math.trunc(q.value) * sign;
  switch (key) {
    case 'a':
    case 'mo': {
      // to the same day of the target month, or its last day (Jan 31 + 1 month = Feb 29)
      const months = key === 'a' ? 12 * n : n;
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + months);
      const last = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
      ).getUTCDate();
      d.setUTCDate(Math.min(day, last));
      break;
    }
    case 'wk':
      d.setUTCDate(d.getUTCDate() + 7 * n);
      break;
    case 'd':
      d.setUTCDate(d.getUTCDate() + n);
      break;
    case 'h':
      d.setUTCHours(d.getUTCHours() + n);
      break;
    case 'min':
      d.setUTCMinutes(d.getUTCMinutes() + n);
      break;
    case 's':
      if (hasFraction)
        d.setUTCMilliseconds(
          d.getUTCMilliseconds() + Math.round(q.value * 1000) * sign,
        );
      else d.setUTCSeconds(d.getUTCSeconds() + n);
      break;
    case 'ms':
      d.setUTCMilliseconds(d.getUTCMilliseconds() + Math.trunc(q.value * sign));
      break;
  }
  const pad = (x: number, w = 2) => String(x).padStart(w, '0');
  const date = [
    String(d.getUTCFullYear()).padStart(4, '0'),
    pad(d.getUTCMonth() + 1),
    pad(d.getUTCDate()),
  ];
  const count = t.kind === 'Time' ? t.parts.length + 3 : t.parts.length;
  let text = date.slice(0, Math.min(count, 3)).join('-');
  if (count > 3) {
    const seconds =
      pad(d.getUTCSeconds()) +
      (hasFraction ? '.' + pad(d.getUTCMilliseconds(), 3) : '');
    const time = [pad(d.getUTCHours()), pad(d.getUTCMinutes()), seconds];
    const tt = time.slice(0, count - 3).join(':');
    text = t.kind === 'Time' ? tt : `${text}T${tt}`;
  }
  const tz =
    t.tz === undefined ? '' : (t.text.match(/(Z|[+-]\d{2}:\d{2})$/)?.[1] ?? '');
  return new FpTemporal(t.kind, text + (count > 3 ? tz : ''));
}

function binary(node: BinaryNode): Fn {
  const left = compile(node.left);
  const right = compile(node.right);
  const op = node.op;
  switch (op) {
    case 'and':
      return ctx => {
        const a = toBool(left(ctx), 'and');
        if (a === false) return FALSE;
        const b = toBool(right(ctx), 'and');
        if (b === false) return FALSE;
        return a === true && b === true ? TRUE : EMPTY;
      };
    case 'or':
      return ctx => {
        const a = toBool(left(ctx), 'or');
        if (a === true) return TRUE;
        const b = toBool(right(ctx), 'or');
        if (b === true) return TRUE;
        return a === false && b === false ? FALSE : EMPTY;
      };
    case 'xor':
      return ctx => {
        const a = toBool(left(ctx), 'xor');
        const b = toBool(right(ctx), 'xor');
        return a === undefined || b === undefined ? EMPTY : bool(a !== b);
      };
    case 'implies':
      return ctx => {
        const a = toBool(left(ctx), 'implies');
        if (a === false) return TRUE;
        const b = toBool(right(ctx), 'implies');
        if (b === true) return TRUE;
        return a === true && b === false ? FALSE : EMPTY;
      };
    case '|':
      return ctx => union(left(ctx), right(ctx));
    case '=':
    case '!=':
      return ctx => {
        const a = left(ctx);
        const b = right(ctx);
        if (!a.length || !b.length) return EMPTY;
        let eq: boolean | undefined = a.length === b.length;
        for (let i = 0; eq && i < a.length; i++) {
          const e = itemEquals(a[i], b[i]);
          if (e === undefined) return EMPTY;
          eq = e;
        }
        return bool(op === '=' ? eq : !eq);
      };
    case '~':
    case '!~':
      return ctx => {
        const a = left(ctx);
        const b = right(ctx);
        let eq: boolean;
        if (!a.length || !b.length) eq = a.length === b.length;
        else
          eq =
            a.length === b.length &&
            a.every(x => b.some(y => itemEquivalent(x, y)));
        return bool(op === '~' ? eq : !eq);
      };
    case '<':
    case '>':
    case '<=':
    case '>=':
      return ctx => {
        const a = single(left(ctx), op);
        const b = single(right(ctx), op);
        if (!a || !b) return EMPTY;
        const c = itemCompare(a, b);
        if (c === undefined) return EMPTY;
        return bool(
          op === '<'
            ? c < 0
            : op === '>'
              ? c > 0
              : op === '<='
                ? c <= 0
                : c >= 0,
        );
      };
    case 'in':
    case 'contains':
      return ctx => {
        const [elem, coll] =
          op === 'in' ? [left(ctx), right(ctx)] : [right(ctx), left(ctx)];
        const e = single(elem, op);
        if (!e) return EMPTY;
        return bool(coll.some(c => itemEquals(e, c) === true));
      };
    case '&':
      return ctx => {
        const a = single(left(ctx), '&');
        const b = single(right(ctx), '&');
        return [
          new Item(String(a?.v ?? '') + String(b?.v ?? ''), 'System.String'),
        ];
      };
    default:
      return ctx => {
        const a = single(left(ctx), op);
        const b = single(right(ctx), op);
        if (!a || !b) return EMPTY;
        return arithmetic(op, a, b);
      };
  }
}
