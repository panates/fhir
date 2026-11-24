/**
 * The evaluation context and the helpers that both the compiler
 * (evaluate.ts) and the functions (functions.ts) use
 */
import type { FhirPathNode } from './ast.js';
import type { FhirPathModel } from './model.js';
import { SYSTEM_TYPE_OF_PRIMITIVE } from './model.js';
import {
  DECIMAL_TEXT,
  FhirPathError,
  FpQuantity,
  FpTemporal,
  Item,
  itemEquals,
  systemType,
} from './values.js';

/** A compiled expression part: the collection it gives in a context */
export type Fn = (ctx: EvalContext) => Item[];

/** Options of an evaluation, given by the caller */
export interface FhirPathEnv {
  model?: FhirPathModel;
  /** %name values, without the % */
  vars: Record<string, Item[]>;
  /** resolve(): the resource a reference names, or undefined */
  resolve?: (reference: string, ctx: EvalContext) => unknown;
  /** memberOf(): whether a code, Coding or CodeableConcept is in a value set; undefined: not known */
  memberOf?: (value: unknown, valueSet: string) => boolean | undefined;
  /** trace(): where traced values go; nothing by default */
  trace?: (name: string, values: unknown[]) => void;
  /** now(): the moment of the evaluation */
  now: Date;
  /**
   * Lenient typing: a FHIR primitive is also its System type
   * (`Patient.active.is(Boolean)`), and `as` takes a collection. Some R4
   * invariants are written that way; the specification is strict.
   */
  lenient?: boolean;
  /** conformsTo(): whether a value conforms to a profile; undefined: not known here */
  conformsTo?: (value: unknown, url: string) => boolean | undefined;
}

export interface EvalContext {
  env: FhirPathEnv;
  /** $this: the focus; the input at the start of the expression */
  focus: Item[];
  /** $index in where(), select() ... */
  index?: number;
  /** $total in aggregate() */
  total?: Item[];
  /** Variables defineVariable() made for the rest of the invocation chain */
  scope?: Readonly<Record<string, Item[]>>;
}

/**
 * The variables of defineVariable() travel with the items along the chain
 * (`a.defineVariable('x').select(%x)`): kept on the result array, under
 * this key, not seen by the other operators (`|`, `and` ...)
 */
export const SCOPE = Symbol('fhirpath.scope');
type Scoped = Item[] & { [SCOPE]?: Readonly<Record<string, Item[]>> };

/** The items with the variables of a scope attached */
export function withScope(
  items: Item[],
  scope: Readonly<Record<string, Item[]>> | undefined,
): Item[] {
  if (!scope) return items;
  const out: Scoped = [...items];
  out[SCOPE] = scope;
  return out;
}

/** Runs the next step of a chain with the scope its target's items carry */
export function chained(
  ctx: EvalContext,
  items: Item[],
  step: (ctx: EvalContext, items: Item[]) => Item[],
): Item[] {
  const scope = (items as Scoped)[SCOPE];
  if (!scope) return step(ctx, items);
  const out = step({ ...ctx, scope }, items);
  // a step that defines a variable carries its own, larger scope on
  return (out as Scoped)[SCOPE] ? out : withScope(out, scope);
}

/** Names defineVariable() may not take: the environment's and the specification's */
export function isSystemVariable(env: FhirPathEnv, name: string): boolean {
  return (
    name in env.vars ||
    name in KNOWN_VARS ||
    name.startsWith('vs-') ||
    name.startsWith('ext-')
  );
}

/* ------------------------------------------------------------------ */
/* Navigation                                                         */
/* ------------------------------------------------------------------ */

const isObject = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** The type of a value of `type`: a resource's own type for an abstract Resource */
function refineType(
  model: FhirPathModel | undefined,
  type: string | undefined,
  v: any,
): string | undefined {
  if (
    isObject(v) &&
    typeof v.resourceType === 'string' &&
    (!type || type === 'Resource' || type === 'DomainResource')
  )
    return model && !model.hasType(v.resourceType) ? type : v.resourceType;
  return type;
}

/** The text a number was read with (@fhirjs/core keeps it beside the value) */
const textOf = (
  holder: any,
  key: string | number,
  v: unknown,
): string | undefined =>
  typeof v === 'number' ? holder?.[DECIMAL_TEXT]?.[key] : undefined;

/** Items for the value(s) of a JSON key, with the `_key` primitive extensions */
function pushValues(
  out: Item[],
  model: FhirPathModel | undefined,
  v: unknown,
  ext: unknown,
  type: string | undefined,
  holder?: any,
  key?: string,
) {
  if (Array.isArray(v) || Array.isArray(ext)) {
    const va = Array.isArray(v) ? v : [];
    const xa = Array.isArray(ext) ? ext : [];
    const n = Math.max(va.length, xa.length);
    for (let i = 0; i < n; i++) {
      const value = va[i];
      const x = xa[i] ?? undefined;
      if ((value === undefined || value === null) && !x) continue;
      out.push(
        new Item(
          value ?? null,
          refineType(model, type, value),
          x,
          textOf(va, i, value),
        ),
      );
    }
    return;
  }
  if ((v === undefined || v === null) && !ext) return;
  out.push(
    new Item(
      v ?? null,
      refineType(model, type, v),
      ext ?? undefined,
      key ? textOf(holder, key, v) : undefined,
    ),
  );
}

/** item.name: a child element (all the JSON keys of a choice) */
export function navigate(
  env: FhirPathEnv,
  items: Item[],
  name: string,
): Item[] {
  const out: Item[] = [];
  const model = env.model;
  for (const item of items) {
    const v = item.v;
    // a primitive: its id and extensions are in its `_x` element
    if (!isObject(v) || v instanceof FpQuantity || v instanceof FpTemporal) {
      const x = item.x;
      // a FHIR primitive's value element (mustHaveValue.value): the value as its System type
      if (
        name === 'value' &&
        v !== null &&
        v !== undefined &&
        item.t &&
        model?.isPrimitive(item.t)
      ) {
        const st = SYSTEM_TYPE_OF_PRIMITIVE[item.t];
        if (st) out.push(new Item(v, `System.${st}`, undefined, item.s));
        continue;
      }
      if (x && (name === 'extension' || name === 'id'))
        pushValues(
          out,
          model,
          x[name],
          undefined,
          name === 'id' ? 'string' : 'Extension',
        );
      continue;
    }
    const children =
      model && item.t ? model.getChildren(item.t, name) : undefined;
    if (children) {
      for (const c of children)
        pushValues(out, model, v[c.key], v['_' + c.key], c.type, v, c.key);
      continue;
    }
    if (model && item.t && model.hasType(item.t)) {
      // lenient: a choice by its JSON key (Observation.valueQuantity)
      if (env.lenient) {
        const c = model.allChildren(item.t).find(x => x.key === name);
        if (c)
          pushValues(out, model, v[c.key], v['_' + c.key], c.type, v, c.key);
      }
      continue; // the type has no such element
    }
    // no model (or a type it does not know): the JSON key, or a choice by prefix
    if (name in v || '_' + name in v) {
      pushValues(out, model, v[name], v['_' + name], undefined, v, name);
      continue;
    }
    for (const k of Object.keys(v)) {
      if (
        k.length > name.length &&
        k.startsWith(name) &&
        k[name.length] >= 'A' &&
        k[name.length] <= 'Z'
      )
        pushValues(out, model, v[k], v['_' + k], undefined, v, k);
    }
  }
  return out;
}

/** children(): every child of each item */
export function childrenOf(env: FhirPathEnv, items: Item[]): Item[] {
  const out: Item[] = [];
  const model = env.model;
  for (const item of items) {
    const v = item.v;
    if (!isObject(v) || v instanceof FpQuantity || v instanceof FpTemporal) {
      if (item.x) {
        if (item.x.id !== undefined)
          pushValues(out, model, item.x.id, undefined, 'string');
        pushValues(out, model, item.x.extension, undefined, 'Extension');
      }
      continue;
    }
    if (model && item.t && model.hasType(item.t)) {
      for (const c of model.allChildren(item.t))
        pushValues(out, model, v[c.key], v['_' + c.key], c.type, v, c.key);
      continue;
    }
    for (const k of Object.keys(v)) {
      if (k.startsWith('_') || k === 'resourceType') continue;
      pushValues(out, model, v[k], v['_' + k], undefined, v, k);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

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

/**
 * Whether an item is of a type: 'Patient', 'FHIR.string', 'System.Boolean',
 * 'Quantity'. `exact`, for as() and ofType(): a primitive is only its own
 * type (a code is() a string, but code.as(string) is empty, as the HL7 suite has it).
 */
export function isOfType(
  env: FhirPathEnv,
  item: Item,
  typeName: string,
  exact = false,
): boolean {
  let ns: string | undefined;
  let name = typeName;
  const dot = typeName.indexOf('.');
  if (
    dot > 0 &&
    (typeName.startsWith('FHIR.') || typeName.startsWith('System.'))
  ) {
    ns = typeName.slice(0, dot);
    name = typeName.slice(dot + 1);
  }
  const model = env.model;
  if (ns !== 'System') {
    if (item.t && !item.t.startsWith('System.')) {
      if (model?.hasType(item.t)) {
        if (exact && model.isPrimitive(item.t) && model.isPrimitive(name))
          return item.t === name;
        if (model.hasType(name)) return model.isType(item.t, name);
      } else if (item.t === name) return true;
    }
    // a resource without type information: its resourceType
    if (!item.t && isObject(item.v) && item.v.resourceType === name)
      return true;
    if (ns === 'FHIR') return false;
    // FHIR's Quantity and its specializations are System Quantities too
    if (
      name === 'Quantity' &&
      item.t &&
      model?.hasType(item.t) &&
      model.isType(item.t, 'Quantity')
    )
      return true;
  }
  if (!SYSTEM_TYPES.has(name)) return false;
  if (
    item.t &&
    !item.t.startsWith('System.') &&
    ns !== 'System' &&
    model?.hasType(item.t) &&
    model.hasType(name)
  )
    return false;
  // a FHIR primitive is not a System type, unless lenient
  if (
    item.t &&
    !item.t.startsWith('System.') &&
    model?.hasType(item.t) &&
    !env.lenient
  )
    return false;
  return systemType(item) === name;
}

/** Throws when a type name is known to no one: neither System nor the model */
export function checkTypeName(env: FhirPathEnv, typeName: string): void {
  // System.Patient is simply no System type: the test is false
  if (typeName.startsWith('System.') || !env.model) return;
  const name = typeName.startsWith('FHIR.') ? typeName.slice(5) : typeName;
  if (typeName === name && SYSTEM_TYPES.has(name)) return;
  if (!env.model.hasType(name))
    throw new FhirPathError(`Unknown type ${typeName}`);
}

/** The name a type argument (ofType(Patient), is(FHIR.string)) is written as */
export function typeNameOf(node: FhirPathNode): string {
  if (node.kind === 'identifier') return node.name;
  if (node.kind === 'member' && node.target.kind === 'identifier')
    return `${node.target.name}.${node.name}`;
  throw new FhirPathError('Expected a type name');
}

/* ------------------------------------------------------------------ */
/* Booleans                                                           */
/* ------------------------------------------------------------------ */

/**
 * A collection as a boolean (singleton evaluation): undefined when empty; a
 * Boolean's value; true for any other single item. More than one item is an error.
 */
export function toBool(items: Item[], what: string): boolean | undefined {
  if (!items.length) return;
  if (items.length > 1)
    throw new FhirPathError(
      `${what} expects a single item, got ${items.length}`,
    );
  const v = items[0].v;
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return; // a primitive with only extensions
  return true;
}

export const TRUE = [new Item(true, 'System.Boolean')];
export const FALSE = [new Item(false, 'System.Boolean')];
export const EMPTY: Item[] = [];
export const bool = (b: boolean | undefined): Item[] =>
  b === undefined ? EMPTY : b ? TRUE : FALSE;

/** Union of collections, without duplicates (by =) */
export function union(a: Item[], b: Item[]): Item[] {
  const out: Item[] = [];
  for (const i of [...a, ...b])
    if (!out.some(o => itemEquals(o, i) === true)) out.push(i);
  return out;
}

export const KNOWN_VARS: Record<string, string> = {
  ucum: 'http://unitsofmeasure.org',
  sct: 'http://snomed.info/sct',
  loinc: 'http://loinc.org',
};
