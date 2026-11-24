/*
 * Static checking of a FHIRPath expression against the type of its input,
 * before any data: elements a type does not have (name.given1), type names
 * that do not exist, functions given a value they do not take (a Period's
 * toString()), and order on an unordered collection (children().first()).
 *
 * A collection's type is the set of types its items may have. A check fails
 * only when no type of the set fits: Observation.effective (dateTime, Period,
 * Timing, instant).toString() is fine, as one of them can be converted.
 * Type tests on $this narrow the set for the operand they guard:
 *   A implies B, A and B, iif(A, B, ..): B is checked with the types A allows
 *   A or B, iif(A, .., B):               B is checked with the types A excludes
 * An operand no type can reach is not checked.
 */
import type { FhirPathNode, FunctionNode } from './ast.js';
import { FUNCTIONS } from './functions.js';
import { type FhirPathModel, SYSTEM_TYPE_OF_PRIMITIVE } from './model.js';

/** A problem the checker found, with its place in the expression */
export interface FhirPathIssue {
  message: string;
  start: number;
  end: number;
}

export interface FhirPathCheckOptions {
  /**
   * The type of the input: 'Patient', 'Patient.contact', 'string', or the
   * types it may have (['Period', 'Timing']). Unknown: nothing is checked
   * against the input.
   */
  type?: string | readonly string[];
  /** The types of %variables ('resource': 'Patient'); others are of any type */
  vars?: Record<string, string | readonly string[]>;
  /** Lenient typing, as for evaluation: choices by their JSON key (valueQuantity) */
  lenient?: boolean;
}

/** The type of a collection: the types its items may have (undefined: any) */
interface CType {
  types?: ReadonlySet<string>;
  /** From children() or descendants(): no order to take items by */
  unordered?: boolean;
  /** Variables defineVariable() made, for the rest of the chain */
  scope?: Scope;
}

/** %variables made by defineVariable(), by name */
type Scope = Readonly<Record<string, CType>>;

const ANY: CType = {};
const of = (...types: string[]): CType => ({ types: new Set(types) });
const BOOLEAN = of('System.Boolean');
const STRING = of('System.String');
const INTEGER = of('System.Integer');
const DECIMAL = of('System.Decimal');
const TEMPORAL = new Set(['Date', 'DateTime', 'Time']);
const NUMBERS = new Set(['Integer', 'Decimal']);
const SYSTEM_TYPES = new Set([
  'Boolean',
  'String',
  'Integer',
  'Decimal',
  'Date',
  'DateTime',
  'Time',
  'Quantity',
]);

/** The types of a literal */
const LITERAL_TYPES: Record<string, string> = {
  boolean: 'System.Boolean',
  string: 'System.String',
  integer: 'System.Integer',
  decimal: 'System.Decimal',
  date: 'System.Date',
  dateTime: 'System.DateTime',
  time: 'System.Time',
  quantity: 'System.Quantity',
};

/** Functions that take items by their order */
const ORDERED = new Set(['first', 'last', 'tail', 'skip', 'take']);

/** Functions whose arguments are evaluated on each item ($this) */
const PER_ITEM = new Set([
  'where',
  'select',
  'all',
  'exists',
  'repeat',
  'aggregate',
  'sort',
  'defineVariable',
  'trace',
]);

/** Variables every evaluation has (without %) */
const SYSTEM_VARS = new Set([
  'context',
  'resource',
  'rootResource',
  'ucum',
  'sct',
  'loinc',
]);

/** What a function takes: Strings, primitive values to convert, numbers */
type Takes = 'string' | 'primitive' | 'number';
const TAKES: Record<string, Takes> = {};
for (const f of [
  'length',
  'substring',
  'startsWith',
  'endsWith',
  'contains',
  'upper',
  'lower',
  'replace',
  'matches',
  'matchesFull',
  'replaceMatches',
  'indexOf',
  'toChars',
  'trim',
  'split',
  'encode',
  'decode',
  'escape',
  'unescape',
])
  TAKES[f] = 'string';
for (const f of [
  'toBoolean',
  'toInteger',
  'toDecimal',
  'toString',
  'toQuantity',
  'toDate',
  'toDateTime',
  'toTime',
  'convertsToBoolean',
  'convertsToInteger',
  'convertsToDecimal',
  'convertsToString',
  'convertsToQuantity',
  'convertsToDate',
  'convertsToDateTime',
  'convertsToTime',
])
  TAKES[f] = 'primitive';
for (const f of [
  'abs',
  'ceiling',
  'floor',
  'truncate',
  'exp',
  'ln',
  'sqrt',
  'log',
  'power',
  'round',
])
  TAKES[f] = 'number';

/** The type of a function's result, when it does not depend on its input */
const RETURNS: Record<string, CType> = {};
for (const f of [
  'empty',
  'exists',
  'all',
  'allTrue',
  'anyTrue',
  'allFalse',
  'anyFalse',
  'subsetOf',
  'supersetOf',
  'isDistinct',
  'not',
  'hasValue',
  'is',
  'startsWith',
  'endsWith',
  'contains',
  'matches',
  'matchesFull',
  'memberOf',
  'conformsTo',
  'htmlChecks',
  'hasExtension',
  'comparable',
  'toBoolean',
])
  RETURNS[f] = BOOLEAN;
for (const t of [
  'Boolean',
  'Integer',
  'Decimal',
  'String',
  'Quantity',
  'Date',
  'DateTime',
  'Time',
])
  RETURNS[`convertsTo${t}`] = BOOLEAN;
for (const f of [
  'count',
  'length',
  'indexOf',
  'toInteger',
  'ceiling',
  'floor',
  'truncate',
  'precision',
])
  RETURNS[f] = INTEGER;
for (const f of [
  'toString',
  'substring',
  'upper',
  'lower',
  'replace',
  'replaceMatches',
  'trim',
  'join',
  'encode',
  'decode',
  'escape',
  'unescape',
  'toChars',
  'split',
])
  RETURNS[f] = STRING;
for (const f of ['toDecimal', 'exp', 'ln', 'sqrt', 'log']) RETURNS[f] = DECIMAL;
RETURNS.toQuantity = of('System.Quantity');
RETURNS.toDate = of('System.Date');
RETURNS.toDateTime = of('System.DateTime');
RETURNS.toTime = of('System.Time');
RETURNS.now = of('System.DateTime');
RETURNS.today = of('System.Date');
RETURNS.timeOfDay = of('System.Time');
RETURNS.extension = of('Extension');

/** Functions whose result has the types of their input */
const SAME = new Set([
  'where',
  'distinct',
  'first',
  'last',
  'tail',
  'skip',
  'take',
  'single',
  'intersect',
  'exclude',
  'trace',
  'sort',
  'defineVariable',
  'lowBoundary',
  'highBoundary',
  'abs',
  'round',
  'power',
]);

/**
 * What an operator does with a value: its kind. N: Integer or Decimal, S:
 * String, B: Boolean, D: Date or DateTime, T: Time, Q: a Quantity (System or
 * FHIR), C: another complex type
 */
type Kind = 'N' | 'S' | 'B' | 'D' | 'T' | 'Q' | 'C';

const KIND_OF_SYSTEM: Record<string, Kind> = {
  Integer: 'N',
  Decimal: 'N',
  String: 'S',
  Boolean: 'B',
  Date: 'D',
  DateTime: 'D',
  Time: 'T',
  Quantity: 'Q',
};

/**
 * The pairs of kinds (left, right) an operator takes, as evaluation has them:
 * arithmetic and ordering fail at run time on other pairs. A string on one
 * side of a date is read as a date.
 *
 * Equality (=, ~ and their negations) is not here: it never fails, and the
 * HL7 suites take values of different types as valid operands that are not
 * equal (name.first() = 'Peter' is false).
 */
const PAIRS: Record<string, ReadonlySet<string>> = {};
const pairs = (ops: string[], list: string) => {
  for (const op of ops) PAIRS[op] = new Set(list.split(' '));
};
pairs(['+'], 'NN SS QQ DQ TQ');
pairs(['-'], 'NN QQ DQ TQ');
pairs(['*'], 'NN QQ QN NQ');
pairs(['/'], 'NN QQ QN');
pairs(['div', 'mod'], 'NN');
pairs(['<', '>', '<=', '>='], 'NN SS QQ DD TT DS SD TS ST');

/** The checker of one expression */
class Checker {
  readonly issues: FhirPathIssue[] = [];

  constructor(
    private readonly model: FhirPathModel | undefined,
    private readonly lenient: boolean,
    private readonly vars: Record<string, CType>,
  ) {}

  private fail(node: FhirPathNode, message: string) {
    this.issues.push({ message, start: node.start, end: node.end });
  }

  /** The name a type set is written with in messages */
  private label(t: CType): string {
    return t.types ? [...t.types].join(' | ') || 'nothing' : 'any';
  }

  /** Whether a type (model or System) is a model type (FHIR.x) */
  private isModelType(t: string): boolean {
    return !t.startsWith('System.') && !!this.model?.hasType(t);
  }

  /** Whether a type name exists: System types, the model's */
  private knownTypeName(name: string): boolean {
    // System.Patient is no System type: a test for it is false, not an error
    if (name.startsWith('System.')) return true;
    const n = name.startsWith('FHIR.') ? name.slice(5) : name;
    if (!name.startsWith('FHIR.') && SYSTEM_TYPES.has(n)) return true;
    return !this.model || this.model.hasType(n);
  }

  /** Whether an item of type `t` is of type `name` ('Period', 'FHIR.string', 'System.Boolean') */
  typeIs(t: string, name: string): boolean {
    let ns: string | undefined;
    let n = name;
    if (name.startsWith('System.') || name.startsWith('FHIR.')) {
      ns = name.slice(0, name.indexOf('.'));
      n = name.slice(ns.length + 1);
    }
    if (t.startsWith('System.')) return ns !== 'FHIR' && t === `System.${n}`;
    if (
      ns === 'System' ||
      (!ns && SYSTEM_TYPES.has(n) && !this.model?.hasType(n))
    ) {
      // a FHIR primitive is its System type only when lenient
      return (
        this.lenient &&
        !!this.model?.isPrimitive(t) &&
        SYSTEM_TYPE_OF_PRIMITIVE[t] === n
      );
    }
    if (!this.model?.hasType(t)) return t === n;
    return this.model.hasType(n) && this.model.isType(t, n);
  }

  /** The types of `set` a type test lets through, and those it does not */
  private narrow(
    set: ReadonlySet<string>,
    name: string,
  ): { yes: Set<string>; no: Set<string> } {
    const yes = new Set<string>();
    const no = new Set<string>();
    for (const t of set) {
      if (this.typeIs(t, name)) yes.add(t);
      else {
        no.add(t);
        // a base type may hold the subtype tested for (Resource is Patient)
        const n = name.replace(/^FHIR\./, '');
        if (
          this.isModelType(t) &&
          this.model!.hasType(n) &&
          this.model!.isType(n, t)
        )
          yes.add(n);
      }
    }
    return { yes, no };
  }

  /**
   * What a condition tells of $this: the types it may have when the
   * condition is true, and when it is false. Undefined: nothing.
   */
  private guard(
    node: FhirPathNode,
    focus: CType,
  ): { yes: ReadonlySet<string>; no: ReadonlySet<string> } | undefined {
    const set = focus.types;
    if (!set) return;
    const isThis = (n: FhirPathNode | undefined) =>
      !n || (n.kind === 'variable' && n.name === '$this');
    if (node.kind === 'typeop' && node.op === 'is' && isThis(node.operand))
      return this.narrow(set, node.typeName);
    if (node.kind === 'function') {
      if (node.name === 'is' && isThis(node.target) && node.args[0]) {
        const a = node.args[0];
        const name =
          a.kind === 'identifier'
            ? a.name
            : a.kind === 'member' && a.target.kind === 'identifier'
              ? `${a.target.name}.${a.name}`
              : undefined;
        if (name) return this.narrow(set, name);
      }
      if (node.name === 'not' && node.target && !node.args.length) {
        const g = this.guard(node.target, focus);
        return g && { yes: g.no, no: g.yes };
      }
    }
    if (node.kind === 'binary' && (node.op === 'and' || node.op === 'or')) {
      const a = this.guard(node.left, focus) ?? { yes: set, no: set };
      const b = this.guard(node.right, focus) ?? { yes: set, no: set };
      if (a.yes === set && a.no === set && b.yes === set && b.no === set)
        return;
      const inter = (x: ReadonlySet<string>, y: ReadonlySet<string>) =>
        new Set([...x].filter(t => y.has(t)));
      const union = (x: ReadonlySet<string>, y: ReadonlySet<string>) =>
        new Set([...x, ...y]);
      return node.op === 'and'
        ? { yes: inter(a.yes, b.yes), no: union(a.no, b.no) }
        : { yes: union(a.yes, b.yes), no: inter(a.no, b.no) };
    }
    return;
  }

  /** Checks a guarded operand with $this narrowed; nothing when no type reaches it */
  private guarded(
    node: FhirPathNode,
    focus: CType,
    types: ReadonlySet<string> | undefined,
    scope: Scope,
  ): CType {
    if (!types) return this.check(node, focus, scope);
    if (!types.size) return ANY; // unreachable
    return this.check(node, { ...focus, types }, scope);
  }

  /** The children named `name` of a collection's types; an issue when none has one */
  private navigate(node: FhirPathNode, input: CType, name: string): CType {
    if (!input.types || !this.model) return ANY;
    if (!input.types.size) return input;
    const out = new Set<string>();
    let open = false;
    for (const t of input.types) {
      if (t.startsWith('System.')) continue;
      if (!this.model.hasType(t)) {
        open = true;
        continue;
      }
      const children = this.model.getChildren(t, name);
      if (children) for (const c of children) out.add(c.type);
      else if (
        this.model.isPrimitive(t) &&
        (name === 'id' || name === 'extension')
      )
        out.add(name === 'id' ? 'string' : 'Extension');
      else if (
        this.model.isPrimitive(t) &&
        name === 'value' &&
        SYSTEM_TYPE_OF_PRIMITIVE[t]
      )
        out.add(`System.${SYSTEM_TYPE_OF_PRIMITIVE[t]}`);
      else if (this.lenient) {
        const c = this.model.allChildren(t).find(x => x.key === name);
        if (c) out.add(c.type);
      }
      // an abstract type (Resource) may be any of its subtypes: not checked
      if (!out.size && this.model.isAbstract?.(t)) open = true;
    }
    if (open) return { ...ANY, unordered: input.unordered };
    if (!out.size) {
      this.fail(node, `${this.label(input)} has no element "${name}"`);
      return ANY;
    }
    return { types: out, unordered: input.unordered };
  }

  /** Whether every type of a collection is one of `system` (System names, or FHIR primitives read as them) */
  private only(t: CType, system: ReadonlySet<string>): boolean {
    if (!t.types || !t.types.size) return false;
    for (const x of t.types) {
      const n = x.startsWith('System.')
        ? x.slice(7)
        : this.model?.isPrimitive(x)
          ? SYSTEM_TYPE_OF_PRIMITIVE[x]
          : undefined;
      if (!n || !system.has(n)) return false;
    }
    return true;
  }

  /** Whether some type of a collection fits what a function takes */
  private takes(t: CType, what: Takes): boolean {
    if (!t.types || !t.types.size) return true;
    for (const x of t.types) {
      const system = x.startsWith('System.')
        ? x.slice(7)
        : this.model?.isPrimitive(x)
          ? SYSTEM_TYPE_OF_PRIMITIVE[x]
          : undefined;
      if (!this.model?.hasType(x) && !x.startsWith('System.')) return true; // not known here
      if (what === 'string' && system === 'String') return true;
      if (
        what === 'number' &&
        (system === 'Integer' || system === 'Decimal' || system === 'Quantity')
      )
        return true;
      if (
        what === 'number' &&
        this.isModelType(x) &&
        this.model!.isType(x, 'Quantity')
      )
        return true;
      if (
        what === 'primitive' &&
        (system || (this.isModelType(x) && this.model!.isType(x, 'Quantity')))
      )
        return true;
    }
    return false;
  }

  /** The kind of a type for operators; undefined when not known here */
  private kindOf(t: string): Kind | undefined {
    if (t.startsWith('System.')) return KIND_OF_SYSTEM[t.slice(7)];
    const m = this.model;
    if (!m?.hasType(t)) return;
    if (m.isPrimitive(t)) return KIND_OF_SYSTEM[SYSTEM_TYPE_OF_PRIMITIVE[t]];
    // an abstract type (Element, DataType) may be a primitive
    if (m.isAbstract?.(t)) return;
    return m.isType(t, 'Quantity') ? 'Q' : 'C';
  }

  /** The kinds of a collection's types; undefined when one is not known */
  private kinds(t: CType): Set<Kind> | undefined {
    if (!t.types?.size) return;
    const out = new Set<Kind>();
    for (const x of t.types) {
      const k = this.kindOf(x);
      if (!k) return;
      out.add(k);
    }
    return out;
  }

  /** Whether an operator takes some type of each side */
  private fits(op: string, left: CType, right: CType): boolean {
    const allowed = PAIRS[op];
    const a = allowed && this.kinds(left);
    const b = allowed && this.kinds(right);
    if (!a || !b) return true;
    for (const x of a) for (const y of b) if (allowed.has(x + y)) return true;
    return false;
  }

  check(node: FhirPathNode, focus: CType, scope: Scope = {}): CType {
    switch (node.kind) {
      case 'literal':
        return node.literal.type === 'empty'
          ? { types: new Set() }
          : of(LITERAL_TYPES[node.literal.type]);
      case 'variable': {
        if (node.name === '$this')
          return { types: focus.types, unordered: focus.unordered };
        if (node.name === '$index') return INTEGER;
        if (node.name === '$total') return ANY;
        const name = node.name.slice(1);
        const t = scope[name] ?? this.vars[name];
        if (t) return t;
        if (name.startsWith('vs-') || name.startsWith('ext-')) return STRING;
        this.fail(node, `Unknown variable ${node.name}`);
        return ANY;
      }
      case 'identifier': {
        const name = node.name;
        // Patient.name: a type name at the start, of the input's type
        if (
          name[0] >= 'A' &&
          name[0] <= 'Z' &&
          focus.types &&
          this.model?.hasType(name)
        ) {
          const { yes } = this.narrow(focus.types, name);
          if (yes.size) return { ...focus, types: yes };
          if (!this.hasChild(focus, name)) {
            this.fail(
              node,
              `${name} is not the type of the input (${this.label(focus)}), nor one of its elements`,
            );
            return ANY;
          }
        }
        return this.navigate(node, focus, name);
      }
      case 'member': {
        const t = this.check(node.target, focus, scope);
        return { ...this.navigate(node, t, node.name), scope: t.scope };
      }
      case 'index': {
        const t = this.check(node.target, focus, scope);
        this.check(node.index, focus, scope);
        if (t.unordered)
          this.fail(
            node,
            'An index needs an ordered collection; children() and descendants() give none',
          );
        return { types: t.types, scope: t.scope };
      }
      case 'unary': {
        const t = this.check(node.operand, focus, scope);
        if (node.op === '-' && !this.takes(t, 'number'))
          this.fail(node, `Cannot negate ${this.label(t)}`);
        return { types: t.types };
      }
      case 'typeop': {
        this.check(node.operand, focus, scope);
        this.typeName(node, node.typeName);
        if (node.op === 'is') return BOOLEAN;
        return this.asType(node.typeName);
      }
      case 'binary':
        return this.binary(node, focus, scope);
      case 'function':
        return this.fn(node, focus, scope);
    }
  }

  private hasChild(focus: CType, name: string): boolean {
    if (!focus.types || !this.model) return true;
    for (const t of focus.types)
      if (this.model.hasType(t) && this.model.getChildren(t, name)) return true;
    return false;
  }

  private typeName(node: FhirPathNode, name: string) {
    if (!this.knownTypeName(name)) this.fail(node, `Unknown type ${name}`);
  }

  /** The type of as(T), ofType(T) */
  private asType(name: string): CType {
    if (name.startsWith('System.')) return of(name);
    const n = name.replace(/^FHIR\./, '');
    if (this.model?.hasType(n)) return of(n);
    if (SYSTEM_TYPES.has(n)) return of(`System.${n}`);
    return ANY;
  }

  private binary(
    node: Extract<FhirPathNode, { kind: 'binary' }>,
    focus: CType,
    scope: Scope,
  ): CType {
    const left = this.check(node.left, focus, scope);
    switch (node.op) {
      case 'and':
      case 'implies':
        this.guarded(
          node.right,
          focus,
          this.guard(node.left, focus)?.yes,
          scope,
        );
        return BOOLEAN;
      case 'or':
        this.guarded(
          node.right,
          focus,
          this.guard(node.left, focus)?.no,
          scope,
        );
        return BOOLEAN;
    }
    const right = this.check(node.right, focus, scope);
    if (
      (node.op === '+' || node.op === '-') &&
      this.only(left, TEMPORAL) &&
      this.only(right, NUMBERS)
    )
      this.fail(
        node,
        `Cannot ${node.op === '+' ? 'add' : 'subtract'} ${this.label(right)} ${node.op === '+' ? 'to' : 'from'} ${this.label(left)}: use a quantity (7 days)`,
      );
    else if (!this.fits(node.op, left, right))
      this.fail(
        node,
        `Cannot apply "${node.op}" to ${this.label(left)} and ${this.label(right)}`,
      );
    switch (node.op) {
      case 'xor':
      case '=':
      case '!=':
      case '~':
      case '!~':
      case '<':
      case '>':
      case '<=':
      case '>=':
      case 'in':
      case 'contains':
        return BOOLEAN;
      case '&':
        return STRING;
      case '|':
        return left.types && right.types
          ? { types: new Set([...left.types, ...right.types]) }
          : ANY;
      default:
        return ANY;
    }
  }

  private fn(node: FunctionNode, focus: CType, outer: Scope): CType {
    const name = node.name;
    if (!Object.hasOwn(FUNCTIONS, name)) {
      this.fail(node, `Unknown function ${name}()`);
      return ANY;
    }
    const impl = FUNCTIONS[name];
    if (
      impl.arity &&
      (node.args.length < impl.arity[0] || node.args.length > impl.arity[1])
    )
      this.fail(
        node,
        `${name}() takes ${impl.arity[0] === impl.arity[1] ? impl.arity[0] : impl.arity.join(' to ')} arguments, ${node.args.length} given`,
      );
    const target = node.target
      ? this.check(node.target, focus, outer)
      : undefined;
    const input: CType = target ?? {
      types: focus.types,
      unordered: focus.unordered,
    };
    // the variables of the chain so far
    const scope = target?.scope ?? outer;
    const carry = (t: CType): CType =>
      target?.scope ? { ...t, scope: target.scope } : t;

    // iif(): the branches under what the criterion tells of $this
    if (name === 'iif') {
      const on = node.target ? input : focus;
      const [c, yes, no] = node.args;
      if (c) {
        const ct = this.check(c, on, scope);
        if (
          ct.types?.size &&
          ![...ct.types].some(t => t === 'System.Boolean' || t === 'boolean')
        )
          this.fail(
            c,
            `The criterion of iif() must be a Boolean, not ${this.label(ct)}`,
          );
      }
      const g = c ? this.guard(c, on) : undefined;
      const a = yes ? this.guarded(yes, on, g?.yes, scope) : ANY;
      const b = no
        ? this.guarded(no, on, g?.no, scope)
        : { types: new Set<string>() };
      return a.types && b.types
        ? { types: new Set([...a.types, ...b.types]) }
        : ANY;
    }

    if (impl.typeArg) {
      const a = node.args[0];
      const t =
        a?.kind === 'identifier'
          ? a.name
          : a?.kind === 'member' && a.target.kind === 'identifier'
            ? `${a.target.name}.${a.name}`
            : undefined;
      if (!t) {
        if (a) this.fail(a, `${name}() takes a type name`);
        return ANY;
      }
      this.typeName(a, t);
      if (name === 'is') return BOOLEAN;
      return carry({ ...this.asType(t), unordered: input.unordered });
    }

    // arguments: on each item, or in the caller's context
    const item: CType = { types: input.types };
    const args = node.args.map(a =>
      // sort(-key): the minus orders, it does not negate (strings sort so too)
      name === 'sort' && a.kind === 'unary' && a.op === '-'
        ? this.check(a.operand, item, scope)
        : this.check(a, PER_ITEM.has(name) ? item : focus, scope),
    );

    if (name === 'defineVariable') {
      const a = node.args[0];
      const v =
        a?.kind === 'literal' && a.literal.type === 'string'
          ? a.literal.value
          : undefined;
      if (v === undefined) {
        if (a)
          this.fail(a, 'defineVariable() takes a name as a String literal');
        return carry(input);
      }
      if (
        scope[v] ||
        SYSTEM_VARS.has(v) ||
        this.vars[v] ||
        v.startsWith('vs-') ||
        v.startsWith('ext-')
      )
        this.fail(a, `%${v} is already defined`);
      return {
        ...input,
        scope: { ...scope, [v]: node.args[1] ? args[1] : input },
      };
    }

    if (ORDERED.has(name) && input.unordered)
      this.fail(
        node,
        `${name}() needs an ordered collection; children() and descendants() give none`,
      );
    const takes = TAKES[name];
    if (takes && !this.takes(input, takes))
      this.fail(
        node,
        `${name}() takes ${takes === 'string' ? 'a String' : takes === 'number' ? 'a number' : 'a primitive value'}, not ${this.label(input)}`,
      );

    if (RETURNS[name]) return carry(RETURNS[name]);
    if (SAME.has(name))
      return carry({ types: input.types, unordered: input.unordered });
    switch (name) {
      case 'select':
      case 'repeat':
        return carry({ types: args[0]?.types, unordered: input.unordered });
      case 'union':
      case 'combine':
        return carry(
          input.types && args[0]?.types
            ? { types: new Set([...input.types, ...args[0].types]) }
            : ANY,
        );
      case 'children':
      case 'descendants':
        return carry({
          types: name === 'children' ? this.allChildTypes(input) : undefined,
          unordered: true,
        });
      default:
        return carry(ANY);
    }
  }

  private allChildTypes(input: CType): ReadonlySet<string> | undefined {
    if (!input.types || !this.model) return;
    const out = new Set<string>();
    for (const t of input.types) {
      if (!this.model.hasType(t) || this.model.isAbstract?.(t)) return;
      for (const c of this.model.allChildren(t)) out.add(c.type);
    }
    return out;
  }
}

/** The type of a check's input, as given */
function typeOf(
  model: FhirPathModel | undefined,
  t: string | readonly string[] | undefined,
): CType {
  if (t === undefined) return ANY;
  const list = typeof t === 'string' ? [t] : t;
  return {
    types: new Set(
      list.map(x =>
        !model?.hasType(x) && SYSTEM_TYPES.has(x) ? `System.${x}` : x,
      ),
    ),
  };
}

/** Checks an expression's syntax tree against the type of its input */
export function checkExpression(
  ast: FhirPathNode,
  model: FhirPathModel | undefined,
  options: FhirPathCheckOptions = {},
): { issues: FhirPathIssue[]; types?: string[] } {
  const input = typeOf(model, options.type);
  const vars: Record<string, CType> = {
    context: input,
    resource: ANY,
    rootResource: ANY,
    ucum: STRING,
    sct: STRING,
    loinc: STRING,
  };
  // %resource: the input, when it is a resource
  if (
    typeof options.type === 'string' &&
    model?.hasType(options.type) &&
    model.isType(options.type, 'Resource')
  ) {
    vars.resource = input;
    vars.rootResource = input;
  }
  for (const [k, v] of Object.entries(options.vars ?? {}))
    vars[k] = typeOf(model, v);
  const checker = new Checker(model, !!options.lenient, vars);
  const result = checker.check(ast, input);
  return { issues: checker.issues, types: result.types && [...result.types] };
}
