import {
  type Context,
  ValidationError,
  type Validator,
  validator,
  vg,
} from 'valgen';
import {
  DECIMAL_TEXT,
  getDecimalText,
  markDecimalText,
  rawDecimal,
} from '../decimal.js';
import type {
  FhirElementInfo,
  FhirExtensionInfo,
  FhirModel,
  FhirSliceInfo,
  FhirTypeInfo,
  FhirValueSet,
} from '../fhir-model.js';
import { resourceTypeOf } from '../resource-type.js';
import type { FhirDataSlicing } from '../types.js';
import { FhirCodecError, toFhirIssues } from './fhir-codec-error.js';
import { primitiveCodec } from './primitive-codec.js';
import type { FhirCodecMode, FhirCodecOptions, FhirIssue } from './types.js';

/*
 * A codec per type, built on valgen as opra's ComplexType.generateCodec:
 * one vg.isObject per type for the object walk, with the FHIR rules valgen
 * has no notion of around it (cardinality counting _x, choices, primitive
 * arrays paired with _x, profiles' extensions and slices, decimals).
 * Issues carry their OperationOutcome type as `fhirCode`.
 */

/** An element of a type, with the marks of one object's pre-pass */
interface ElementPlan {
  element: FhirElementInfo;
  /** The object the element was last seen in (a pass number) */
  stamp: number;
  /** The value key seen first: 'deceasedBoolean' */
  presentKey?: string;
}

/** A JSON key a type accepts */
interface KeyEntry {
  plan?: ElementPlan; // none for resourceType
  /** For '_birthDate', 'birthDate' */
  valueKey: string;
  isExtension: boolean;
  isArray: boolean;
  /** A primitive array or its _x array: items may be null when paired */
  primitiveArray: boolean;
  /** Position in definition order */
  order: number;
  /** A decimal: its source text is carried over (1.50) */
  decimal?: boolean;
}

let passCounter = 0;

const isObjectLike = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** 'name' + 0 -> 'name[0]'; 'name' + 'given' -> 'name.given' */
function join(base: string | undefined, key: string | number): string {
  if (typeof key === 'number') return `${base || ''}[${key}]`;
  return base ? `${base}.${key}` : key;
}

/** A context located below this one */
function at(context: Context, ...keys: (string | number)[]): Context {
  const sub = context.extend();
  let loc = context.location;
  for (const k of keys) loc = join(loc, k);
  sub.location = loc;
  const last = keys[keys.length - 1];
  if (typeof last === 'string') sub.property = last;
  return sub;
}

/** Records an issue with its OperationOutcome type, below the context */
function fail(
  context: Context,
  rule: Validator,
  code: FhirIssue['code'],
  message: string,
  key?: string | number,
  value?: unknown,
): void {
  (key === undefined ? context : at(context, key)).fail(rule, message, value, {
    fhirCode: code,
  });
}

/**
 * Reads and writes the values of one type. Its schema is built from the
 * type's definition the first time it is used, so circular types
 * (Extension.extension, Questionnaire.item.item) need no forward references.
 */
class TypeCodec {
  readonly validator: Validator;
  _keys?: Record<string, KeyEntry>;
  _object!: Validator;
  _required: ElementPlan[] = [];
  _decimalKeys: string[] = [];
  _keyOrder: string[] = [];
  _isResource = false;
  _resourceName?: string;
  /** Extension and slice properties, url, meta.profile: around the object walk */
  _hasSugar = false;
  _extensions: FhirExtensionInfo[] = [];
  _slices: FhirSliceInfo[] = [];
  _sugarKeys = new Set<string>();
  _dataSlices: FhirDataSlicing[] = [];
  _rawDecimals = false;

  constructor(
    readonly owner: FhirCodecs,
    readonly type: FhirTypeInfo,
  ) {
    this.validator = validator(
      'fhir:' + type.name,
      (input: unknown, context: Context, _this) =>
        this.walk(input, context, _this),
    );
  }

  private _compile(): Record<string, KeyEntry> {
    const { owner, type } = this;
    const { mode, options } = owner;
    const keys: Record<string, KeyEntry> = Object.create(null);
    const schema: Record<string, Validator> = {};
    let order = 0;
    this._resourceName = resourceTypeOf(type.ctor);
    this._isResource = !!this._resourceName;
    this._dataSlices = type.dataSlices;
    this._extensions = [...type.extensions.values()];
    this._slices = [...type.slices.values()];
    for (const x of this._extensions) this._sugarKeys.add(x.property);
    for (const x of this._slices) this._sugarKeys.add(x.property);
    this._hasSugar =
      this._sugarKeys.size > 0 ||
      type.kind === 'extension' ||
      (type.kind === 'profile' && this._isResource);
    this._rawDecimals = mode === 'encode' && !!options.rawDecimals;
    const partial = !!options.partial;

    if (this._isResource) {
      keys.resourceType = {
        valueKey: 'resourceType',
        isExtension: false,
        isArray: false,
        primitiveArray: false,
        order: order++,
      };
      schema.resourceType = vg.optional(PASS);
      this._keyOrder.push('resourceType');
    }
    const element = owner.lazy('Element');
    const nullableElement = vg.nullable(element);

    for (const el of type.elements.values()) {
      const plan: ElementPlan = { element: el, stamp: 0 };
      if (el.min > 0) this._required.push(plan);
      for (const et of el.types) {
        const target = owner.model.getType(et.code);
        const primitive = target.kind === 'primitive-type';
        const primitiveArray = primitive && el.isArray;
        let rule: Validator = primitiveArray
          ? primitiveCodec(target, mode, true)
          : target.kind === 'resource'
            ? owner.forResource(target.name)
            : primitive
              ? owner.forType(target.name)
              : target.name === 'Extension' && options.extensions !== false
                ? owner.forExtension()
                : owner.lazy(target.name);
        if (el.pattern !== undefined || el.fixed !== undefined)
          rule = patternCheck(rule, el);
        const binding = el.binding;
        if (binding?.strength === 'required' && options.bindings !== false) {
          const vs = owner.model.getValueSet(binding.valueSet);
          if (vs) rule = bindingCheck(rule, target, vs);
        }
        const entry: KeyEntry = {
          plan,
          valueKey: et.key,
          isExtension: false,
          isArray: el.isArray,
          primitiveArray,
          order: order++,
          decimal: target.name === 'decimal',
        };
        keys[et.key] = entry;
        schema[et.key] = vg.optional(
          el.isArray
            ? arrayCodec(entry, rule, partial, this._rawDecimals)
            : rule,
        );
        this._keyOrder.push(et.key);
        if (entry.decimal && !el.isArray) this._decimalKeys.push(et.key);

        if (primitive && !el.noExtension && target.name !== 'xhtml') {
          const x: KeyEntry = {
            plan,
            valueKey: et.key,
            isExtension: true,
            isArray: el.isArray,
            primitiveArray,
            order: order++,
          };
          keys['_' + et.key] = x;
          schema['_' + et.key] = vg.optional(
            el.isArray
              ? arrayCodec(x, nullableElement, partial, false)
              : element,
          );
          this._keyOrder.push('_' + et.key);
        }
      }
    }
    this._object = vg.isObject(schema, {
      name: type.name,
      ctor:
        mode === 'decode' && !options.plain ? (type.ctor as any) : undefined,
      additionalFields: options.unknownElements !== 'drop',
    });
    return (this._keys = keys);
  }

  walk(input: unknown, context: Context, rule: Validator): unknown {
    if (!this._keys) this._compile();
    if (!isObjectLike(input)) {
      fail(
        context,
        rule,
        'structure',
        `A ${this.type.name} must be a JSON object`,
        undefined,
        input,
      );
      return;
    }
    if (!this._hasSugar) return this._walkObject(input, context, rule);
    if (this.owner.mode === 'decode') {
      const out = this._walkObject(input, context, rule) as
        Record<string, any> | undefined;
      if (out) decodeSugar(this, input, out, context, rule);
      return out;
    }
    return this._walkObject(
      encodeSugar(this, input, context, rule),
      context,
      rule,
    );
  }

  private _walkObject(
    input: Record<string, any>,
    context: Context,
    rule: Validator,
  ): unknown {
    const byKey = this._keys!;
    const { type, owner } = this;
    const { options, mode } = owner;
    // Another resource type: its elements would only add noise
    const rt = input.resourceType;
    if (this._isResource && rt !== undefined && rt !== this._resourceName) {
      fail(
        context,
        rule,
        'structure',
        `resourceType must be "${this._resourceName}", not "${rt}"`,
        'resourceType',
        rt,
      );
      return;
    }
    const unknown = options.unknownElements || 'error';
    const pass = ++passCounter;
    const keys = Object.keys(input);
    let ordered = true;
    let last = -1;
    let defined = 0;

    // Pre-pass over the object's own keys (no recursion, so the marks hold)
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = input[k];
      if (v === undefined) continue;
      defined++;
      const e = byKey[k];
      if (!e) {
        if (unknown === 'error')
          fail(
            context,
            rule,
            'structure',
            `${type.name} has no element "${k}"`,
            k,
            v,
          );
        else if (unknown === 'keep') last = Infinity;
        continue;
      }
      if (e.order < last) ordered = false;
      last = e.order;
      const p = e.plan;
      if (!p) continue;
      if (p.stamp === pass) {
        if (p.presentKey !== e.valueKey) {
          const el = p.element;
          fail(
            context,
            rule,
            'structure',
            `Only one of ${el.types.map(t => t.key).join(', ')} may be present (${el.name})`,
            k,
            v,
          );
        }
      } else {
        p.stamp = pass;
        p.presentKey = e.valueKey;
        if (p.element.max === 0)
          fail(
            context,
            rule,
            'structure',
            `${p.element.name} is not allowed in ${type.name}`,
            k,
            v,
          );
      }
      if (
        e.primitiveArray &&
        (!e.isExtension || input[e.valueKey] === undefined)
      )
        checkPairing(e.valueKey, input, context, rule);
    }
    if (!options.partial)
      for (const p of this._required)
        if (p.stamp !== pass)
          fail(
            context,
            rule,
            'required',
            `${p.element.name} is required`,
            p.element.name,
          );
    if (!this._isResource && !defined) {
      fail(
        context,
        rule,
        'structure',
        `A ${type.name} must have a value or children`,
        undefined,
        input,
      );
      return;
    }
    if (this._isResource && rt === undefined && mode === 'decode')
      fail(
        context,
        rule,
        'required',
        `resourceType is required (${this._resourceName})`,
        'resourceType',
      );
    if (this._dataSlices.length)
      checkDataSlices(this._dataSlices, input, context, rule, owner);

    const out = this._object(input, undefined, context) as
      Record<string, any> | undefined;
    if (!out) return out;
    for (const k of this._decimalKeys)
      if (typeof out[k] === 'number')
        carryDecimal(input, k, out, k, out[k], this._rawDecimals);
    if (mode !== 'encode') return out;
    if (this._isResource && out.resourceType === undefined) {
      out.resourceType = this._resourceName;
      ordered = false;
    }
    return ordered ? out : reorder(out, this._keyOrder, byKey);
  }
}

/** Takes any value as it is (resourceType, checked by the type's codec) */
const PASS = validator('fhir:pass', (v: unknown) => v);

/** Keys in definition order (resourceType, x, _x, ...); unknown ones last */
function reorder(
  out: Record<string, any>,
  order: string[],
  known: Record<string, KeyEntry>,
) {
  const r: Record<string, any> = {};
  for (const k of order) if (out[k] !== undefined) r[k] = out[k];
  for (const k of Object.keys(out)) if (!known[k]) r[k] = out[k];
  const marks = (out as any)[DECIMAL_TEXT];
  if (marks) Object.defineProperty(r, DECIMAL_TEXT, { value: marks });
  return r;
}

/** Items of a repeating element: not empty, within max; location gets [i] */
function arrayCodec(
  e: KeyEntry,
  item: Validator,
  partial: boolean,
  rawDecimals: boolean,
): Validator {
  return validator('fhir:array', (input: unknown, context: Context, _this) => {
    if (!Array.isArray(input)) {
      fail(
        context,
        _this,
        'structure',
        'A repeating element must be a JSON array',
        undefined,
        input,
      );
      return;
    }
    const n = input.length;
    if (!n) {
      fail(
        context,
        _this,
        'structure',
        'An array must not be empty',
        undefined,
        input,
      );
      return;
    }
    const el = e.plan!.element;
    if (n > el.max && el.max > 0)
      fail(
        context,
        _this,
        'structure',
        `${el.name} has ${n} items, at most ${el.max} allowed`,
        undefined,
        input,
      );
    if (!partial && n < el.min && !e.isExtension)
      fail(
        context,
        _this,
        'structure',
        `${el.name} has ${n} items, at least ${el.min} required`,
        undefined,
        input,
      );
    const out = new Array(n);
    const base = context.location;
    const sub = context.extend();
    for (let i = 0; i < n; i++) {
      sub.location = join(base, i);
      sub.index = i;
      const r = item(input[i], undefined, sub);
      if (e.decimal && typeof r === 'number')
        carryDecimal(input, i, out, i, r, rawDecimals);
      else out[i] = r;
    }
    return out;
  });
}

/** A primitive array and its _x array: same length, no item null in both */
function checkPairing(
  key: string,
  input: Record<string, any>,
  context: Context,
  rule: Validator,
): void {
  const v = input[key];
  const x = input['_' + key];
  const va = Array.isArray(v);
  const xa = Array.isArray(x);
  if (!va && !xa) return;
  if (va && xa && v.length !== x.length) {
    fail(
      context,
      rule,
      'structure',
      `_${key} must have as many items as ${key} (${x.length} != ${v.length})`,
      '_' + key,
      x,
    );
    return;
  }
  const n = va ? v.length : x.length;
  for (let j = 0; j < n; j++)
    if ((va ? v[j] : null) == null && (xa ? x[j] : null) == null)
      at(context, va ? key : '_' + key, j).fail(
        rule,
        'An item must have a value or extensions',
        null,
        {
          fhirCode: 'structure',
        },
      );
}

/** Moves claimed extension entries and slice items to their properties */
function decodeSugar(
  self: TypeCodec,
  input: Record<string, any>,
  out: Record<string, any>,
  context: Context,
  rule: Validator,
): void {
  const { type, owner } = self;
  const partial = !!owner.options.partial;
  if (type.kind === 'extension' && input.url !== type.url)
    fail(context, rule, 'value', `url must be "${type.url}"`, 'url', input.url);

  const claimed = new Map<string, Set<number>>();
  const claim = (key: string, i: number) => {
    let set = claimed.get(key);
    if (!set) claimed.set(key, (set = new Set()));
    set.add(i);
  };

  for (const x of self._extensions) {
    const arrKey = x.modifier ? 'modifierExtension' : 'extension';
    const arr = input[arrKey];
    const idx: number[] = [];
    if (Array.isArray(arr))
      for (let i = 0; i < arr.length; i++)
        if (arr[i]?.url === x.url) idx.push(i);
    countCheck(
      context,
      rule,
      x.property,
      idx.length,
      x.min,
      x.max,
      partial,
      arrKey,
      x.url,
    );
    if (!idx.length) continue;
    const values: unknown[] = [];
    for (const i of idx) {
      claim(arrKey, i);
      const decoded = out[arrKey]?.[i];
      let v: unknown;
      if (x.definition)
        v = owner.forType(x.definition.name)(
          arr[i],
          undefined,
          at(context, arrKey, i),
        );
      if (x.complex) values.push(v);
      else {
        // a definition's codec has checked the value; otherwise check here
        const from: any = x.definition ? v : decoded;
        const key = valueKeyOf(x.valueType!);
        if (from?.[key] !== undefined) {
          const text = getDecimalText(from, key);
          if (text !== undefined) markDecimalText(values, values.length, text);
          values.push(from[key]);
        } else if (!x.definition && decoded)
          at(context, arrKey, i).fail(
            rule,
            `The extension ${x.url} must have ${key}`,
            arr[i],
            { fhirCode: 'value' },
          );
      }
    }
    setSugar(out, x.property, values, x.isArray);
  }

  for (const sl of self._slices) {
    const key = sl.element.name;
    const arr = input[key];
    const idx: number[] = [];
    const taken = claimed.get(key);
    if (Array.isArray(arr))
      for (let i = 0; i < arr.length; i++)
        if (!taken?.has(i) && matchesPattern(arr[i], sl.pattern)) idx.push(i);
    countCheck(
      context,
      rule,
      sl.property,
      idx.length,
      sl.min,
      sl.max,
      partial,
      key,
      sl.name,
    );
    if (!idx.length) continue;
    const values: unknown[] = [];
    for (const i of idx) {
      claim(key, i);
      values.push(out[key]?.[i]);
    }
    setSugar(out, sl.property, values, sl.isArray);
  }

  for (const [key, set] of claimed) {
    const a = out[key];
    if (!Array.isArray(a)) continue;
    const rest = a.filter((_, i) => !set.has(i));
    if (rest.length) out[key] = rest;
    else delete out[key];
  }
}

/** Writes extension and slice properties back into their arrays */
function encodeSugar(
  self: TypeCodec,
  input: Record<string, any>,
  context: Context,
  rule: Validator,
): Record<string, any> {
  const { type, owner } = self;
  const partial = !!owner.options.partial;
  const src: Record<string, any> = {};
  for (const k of Object.keys(input))
    if (!self._sugarKeys.has(k)) src[k] = input[k];
  const marks = (input as any)[DECIMAL_TEXT];
  if (marks) Object.defineProperty(src, DECIMAL_TEXT, { value: marks });

  if (type.kind === 'extension' && src.url === undefined) src.url = type.url;

  for (const x of self._extensions) {
    const v = input[x.property];
    const arrKey = x.modifier ? 'modifierExtension' : 'extension';
    const vals = sugarValues(context, rule, x.property, v, x.isArray);
    countCheck(
      context,
      rule,
      x.property,
      vals.length,
      x.min,
      x.max,
      partial,
      x.property,
      x.url,
    );
    if (!vals.length) continue;
    const entries: unknown[] = [];
    for (let i = 0; i < vals.length; i++) {
      const val = vals[i];
      if (x.complex) {
        const sub = x.isArray
          ? at(context, x.property, i)
          : at(context, x.property);
        entries.push(owner.forType(x.definition!.name)(val, undefined, sub));
      } else {
        const key = valueKeyOf(x.valueType!);
        const entry: Record<string, unknown> = { url: x.url, [key]: val };
        const text = x.isArray
          ? getDecimalText(v, i)
          : getDecimalText(input, x.property);
        if (text !== undefined) markDecimalText(entry, key, text);
        entries.push(entry);
      }
    }
    src[arrKey] = [
      ...(Array.isArray(src[arrKey]) ? src[arrKey] : []),
      ...entries,
    ];
  }

  const sliceItems = new Map<string, unknown[]>();
  for (const sl of self._slices) {
    const v = input[sl.property];
    const vals = sugarValues(context, rule, sl.property, v, sl.isArray);
    countCheck(
      context,
      rule,
      sl.property,
      vals.length,
      sl.min,
      sl.max,
      partial,
      sl.property,
      sl.name,
    );
    const key = sl.element.name;
    let list = sliceItems.get(key);
    if (!list) sliceItems.set(key, (list = []));
    for (let i = 0; i < vals.length; i++) {
      const item = fillPattern(vals[i], sl.pattern);
      if (!matchesPattern(item, sl.pattern)) {
        const sub = sl.isArray
          ? at(context, sl.property, i)
          : at(context, sl.property);
        sub.fail(rule, `Does not match the slice ${sl.name}`, item, {
          fhirCode: 'value',
        });
      }
      list.push(item);
    }
  }
  // Slice items first, in slice order; then the element's other items
  for (const [key, items] of sliceItems)
    if (items.length)
      src[key] = [...items, ...(Array.isArray(src[key]) ? src[key] : [])];

  if (type.kind === 'profile' && self._isResource) {
    const meta = isObjectLike(src.meta) ? src.meta : undefined;
    const profiles: unknown[] = Array.isArray(meta?.profile)
      ? meta!.profile
      : [];
    if (!profiles.includes(type.url)) {
      const m: Record<string, any> = {};
      if (meta) for (const k of Object.keys(meta)) m[k] = meta[k];
      m.profile = [...profiles, type.url];
      src.meta = m;
    }
  }
  return src;
}

/** 'CodeableConcept' -> 'valueCodeableConcept' */
function valueKeyOf(type: string): string {
  return 'value' + type.charAt(0).toUpperCase() + type.slice(1);
}

function setSugar(
  out: Record<string, any>,
  property: string,
  values: unknown[],
  isArray: boolean,
) {
  if (!values.length) return;
  out[property] = isArray ? values : values[0];
  if (!isArray) {
    const text = getDecimalText(values, 0);
    if (text !== undefined) markDecimalText(out, property, text);
  }
}

/** A sugar property's values as a list */
function sugarValues(
  context: Context,
  rule: Validator,
  property: string,
  v: unknown,
  isArray: boolean,
): unknown[] {
  if (v === undefined || v === null) return [];
  if (isArray) {
    if (Array.isArray(v)) return v;
    fail(
      context,
      rule,
      'structure',
      `${property} must be an array`,
      property,
      v,
    );
    return [];
  }
  if (Array.isArray(v)) {
    fail(
      context,
      rule,
      'structure',
      `${property} must not be an array`,
      property,
      v,
    );
    return [];
  }
  return [v];
}

function countCheck(
  context: Context,
  rule: Validator,
  property: string,
  n: number,
  min: number,
  max: number,
  partial: boolean,
  key: string,
  what: string,
) {
  if (!partial && n < min)
    fail(
      context,
      rule,
      'required',
      n
        ? `${property} (${what}) has ${n} items, at least ${min} required`
        : `${property} (${what}) is required`,
      key,
    );
  if (n > max)
    fail(
      context,
      rule,
      'structure',
      `${property} (${what}) has ${n} items, at most ${max} allowed`,
      key,
    );
}

/** Whether a value has every value of a pattern (FHIR pattern[x]) */
export function matchesPattern(value: unknown, pattern: unknown): boolean {
  if (pattern === undefined) return true;
  // a path through a repeating element: one of its items has it
  if (Array.isArray(value) && !Array.isArray(pattern))
    return value.some(v => matchesPattern(v, pattern));
  if (pattern === null || typeof pattern !== 'object') return value === pattern;
  if (Array.isArray(pattern))
    return (
      Array.isArray(value) &&
      pattern.every(p => value.some(v => matchesPattern(v, p)))
    );
  if (!isObjectLike(value)) return false;
  for (const k of Object.keys(pattern))
    if (!matchesPattern(value[k], (pattern as any)[k])) return false;
  return true;
}

/** A copy of an item with the pattern's values it lacks filled in */
function fillPattern(item: unknown, pattern: unknown): unknown {
  if (!isObjectLike(pattern) || !isObjectLike(item)) return item;
  const out: Record<string, any> = Object.assign(
    Object.create(Object.getPrototypeOf(item)),
    item,
  );
  const marks = (item as any)[DECIMAL_TEXT];
  if (marks) Object.defineProperty(out, DECIMAL_TEXT, { value: marks });
  for (const k of Object.keys(pattern)) {
    const p = (pattern as any)[k];
    if (out[k] === undefined) out[k] = structuredClone(p);
    else if (isObjectLike(p) && isObjectLike(out[k]))
      out[k] = fillPattern(out[k], p);
  }
  return out;
}

/**
 * The slicing of a profile read from a StructureDefinition: items go to the
 * first slice whose pattern they match; each slice's cardinality is checked,
 * and its items against the slice's type. Items stay where they are.
 */
function checkDataSlices(
  slicings: FhirDataSlicing[],
  input: Record<string, any>,
  context: Context,
  rule: Validator,
  owner: FhirCodecs,
): void {
  const partial = !!owner.options.partial;
  for (const sl of slicings) {
    const v = input[sl.element];
    const items: unknown[] = Array.isArray(v) ? v : v === undefined ? [] : [v];
    const counts = new Array<number>(sl.slices.length).fill(0);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const k = sl.slices.findIndex(
        x =>
          matchesPattern(item, x.pattern) &&
          (!x.valueSet ||
            inValueSet(item, owner.model.getValueSet(x.valueSet))),
      );
      if (k < 0) {
        if (sl.rules === 'closed')
          at(context, sl.element, i).fail(
            rule,
            'The item is in none of the slices, and the slicing is closed',
            item,
            {
              fhirCode: 'structure',
            },
          );
        continue;
      }
      counts[k]++;
      const slice = sl.slices[k];
      if (slice.itemType)
        owner.forType(slice.itemType)(
          item,
          undefined,
          at(context, sl.element, i),
        );
    }
    sl.slices.forEach((slice, k) => {
      const n = counts[k];
      if (!partial && n < slice.min)
        fail(
          context,
          rule,
          'required',
          n
            ? `Slice ${slice.name} of ${sl.element} has ${n} items, at least ${slice.min} required`
            : `Slice ${slice.name} of ${sl.element} is required`,
          sl.element,
        );
      if (n > slice.max)
        fail(
          context,
          rule,
          'structure',
          `Slice ${slice.name} of ${sl.element} has ${n} items, at most ${slice.max} allowed`,
          sl.element,
        );
    });
  }
}

/** Whether a code, Coding or CodeableConcept has a code of the value set */
function inValueSet(item: any, vs: FhirValueSet | undefined): boolean {
  if (!vs) return false;
  if (typeof item === 'string') return vs.has(item);
  if (!isObjectLike(item)) return false;
  const codings: any[] = Array.isArray(item.coding) ? item.coding : [item];
  return codings.some(
    c =>
      isObjectLike(c) &&
      typeof c.code === 'string' &&
      vs.has(c.code, typeof c.system === 'string' ? c.system : undefined),
  );
}

/** Wraps a value's codec with a profile's fixed or pattern value */
function patternCheck(inner: Validator, element: FhirElementInfo): Validator {
  const { fixed, pattern } = element;
  return validator('fhir:pattern', (v: unknown, context: Context, _this) => {
    const r = inner(v, undefined, context);
    if (r === undefined || r === null) return r;
    if (pattern !== undefined && !matchesPattern(r, pattern))
      context.fail(
        _this,
        `${element.name} does not match the profile's pattern`,
        v,
        { fhirCode: 'value' },
      );
    if (
      fixed !== undefined &&
      !(matchesPattern(r, fixed) && matchesPattern(fixed, r))
    )
      context.fail(
        _this,
        `${element.name} must be the profile's fixed value`,
        v,
        { fhirCode: 'value' },
      );
    return r;
  });
}

/**
 * Wraps a value's codec with the check of a required binding: a code must be
 * in the value set; a Coding or Quantity its system and code; a
 * CodeableConcept at least one of its codings
 */
function bindingCheck(
  inner: Validator,
  target: FhirTypeInfo,
  vs: FhirValueSet,
): Validator {
  const CODE = { fhirCode: 'code-invalid' };
  const notIn = (code: string, system?: string) =>
    `"${system ? system + '#' : ''}${code}" is not in the value set ${vs.url}`;
  const codingOk = (c: any) =>
    !!c &&
    typeof c.code === 'string' &&
    vs.has(c.code, typeof c.system === 'string' ? c.system : undefined);

  if (target.kind === 'primitive-type')
    return validator('fhir:binding', (v: unknown, context: Context, _this) => {
      const r = inner(v, undefined, context);
      if (typeof r === 'string' && !vs.has(r))
        context.fail(_this, notIn(r), v, CODE);
      return r;
    });
  if (target.name === 'Coding' || target.name === 'Quantity')
    return validator('fhir:binding', (v: unknown, context: Context, _this) => {
      const r: any = inner(v, undefined, context);
      if (r && typeof r.code === 'string' && !codingOk(r))
        context.fail(_this, notIn(r.code, r.system), v, CODE);
      return r;
    });
  if (target.name === 'CodeableConcept')
    return validator('fhir:binding', (v: unknown, context: Context, _this) => {
      const r: any = inner(v, undefined, context);
      if (!r) return r;
      const codings: any[] = Array.isArray(r.coding) ? r.coding : [];
      if (!codings.some(codingOk))
        context.fail(
          _this,
          codings.length
            ? `None of the codings (${codings.map(c => (c?.system ? c.system + '#' : '') + c?.code).join(', ')}) is in the value set ${vs.url}`
            : `A coding from the value set ${vs.url} is required`,
          v,
          CODE,
        );
      return r;
    });
  return inner;
}

/**
 * Writes a decimal to `out`, with the source text the input kept for it:
 * as JSON.rawJSON when writing JSON text, as a mark otherwise
 */
function carryDecimal(
  from: object,
  fromKey: string | number,
  out: any,
  key: string | number,
  value: number,
  raw: boolean,
): void {
  const text = getDecimalText(from, fromKey);
  if (text === undefined) out[key] = value;
  else if (raw) out[key] = rawDecimal(value, text);
  else {
    out[key] = value;
    markDecimalText(out, key, text);
  }
}

/**
 * The codecs of one model, mode and option set: valgen validators compiled
 * from the types' definitions and cached by type. Each can be used in a
 * valgen (opra) schema as it is; run() reports issues as a FhirCodecError.
 */
export class FhirCodecs {
  private readonly _types = new Map<string, Validator>();
  private readonly _lazy = new Map<string, Validator>();
  private readonly _resources = new Map<string, Validator>();

  constructor(
    readonly model: FhirModel,
    readonly mode: FhirCodecMode,
    readonly options: FhirCodecOptions = {},
  ) {}

  /**
   * Reads (decode) or writes (encode) a value of a type; without a type, a
   * resource of any type, by its resourceType. Throws FhirCodecError.
   */
  run(type: string | undefined, input: unknown, root?: string): any {
    const codec = type ? this.forType(type) : this.forResource('Resource');
    try {
      return codec(input);
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      const name =
        root ??
        type ??
        (isObjectLike(input) && typeof input.resourceType === 'string'
          ? input.resourceType
          : 'Resource');
      throw new FhirCodecError(toFhirIssues(e.issues, name));
    }
  }

  /** The codec of a type (or of any resource) as a valgen validator */
  toValidator(type?: string): Validator {
    return type ? this.forType(type) : this.forResource('Resource');
  }

  /** The codec of a type by name; for an abstract resource, by resourceType */
  forType(name: string): Validator {
    let codec = this._types.get(name);
    if (!codec) {
      const type = this.model.getType(name);
      if (type.kind === 'primitive-type')
        codec = primitiveCodec(type, this.mode);
      else if (type.kind === 'resource' && type.abstract)
        codec = this.forResource(name);
      else codec = new TypeCodec(this, type).validator;
      this._types.set(name, codec);
    }
    return codec;
  }

  /** forType(), looked up on first use: for circular types */
  lazy(name: string): Validator {
    let v = this._lazy.get(name);
    if (!v) {
      let codec: Validator | undefined;
      v = validator('fhir:' + name, (input: unknown, context: Context) =>
        (codec ||= this.forType(name))(input, undefined, context),
      );
      this._lazy.set(name, v);
    }
    return v;
  }

  /**
   * A codec for an Extension: by the definition its url names, when the
   * model has it (a loaded package's, or a @FhirExtensionType class);
   * otherwise as a plain Extension
   */
  forExtension(): Validator {
    if (this._extension) return this._extension;
    const { model } = this;
    let plain: Validator | undefined;
    return (this._extension = validator(
      'fhir:extension',
      (input: unknown, context: Context) => {
        const url = isObjectLike(input) ? input.url : undefined;
        if (typeof url === 'string' && url.includes(':')) {
          const def = model.findProfile(url);
          // When writing, a definition class with extension or slice properties
          // takes its own instances; an entry already in its JSON form is plain
          const takes =
            def?.kind === 'extension' &&
            (this.mode === 'decode' ||
              !(def.extensions.size || def.slices.size) ||
              input instanceof def.ctor);
          if (takes) return this.forType(def!.name)(input, undefined, context);
        }
        return (plain ||= this.forType('Extension'))(input, undefined, context);
      },
    ));
  }
  private _extension?: Validator;

  /** A codec taking any resource that is a `base`, chosen by its resourceType */
  forResource(base = 'Resource'): Validator {
    let codec = this._resources.get(base);
    if (codec) return codec;
    const { model, mode } = this;
    codec = validator(
      'fhir:resource',
      (input: unknown, context: Context, _this) => {
        if (!isObjectLike(input)) {
          fail(
            context,
            _this,
            'structure',
            'A resource must be a JSON object',
            undefined,
            input,
          );
          return;
        }
        let rt = input.resourceType;
        if (rt === undefined && mode === 'encode')
          rt = resourceTypeOf(input.constructor);
        if (typeof rt !== 'string') {
          fail(
            context,
            _this,
            'required',
            'A resource must have a resourceType',
            undefined,
            input,
          );
          return;
        }
        const type = model.hasType(rt) ? model.getType(rt) : undefined;
        if (!type || type.kind !== 'resource' || type.abstract) {
          fail(
            context,
            _this,
            'not-supported',
            `Unknown resource type "${rt}"`,
            undefined,
            rt,
          );
          return;
        }
        if (!type.isA(base)) {
          fail(
            context,
            _this,
            'structure',
            `A ${rt} is not a ${base}`,
            undefined,
            rt,
          );
          return;
        }
        if (mode === 'encode') {
          // an instance of a profile class: its own codec
          const own = model.typeOfClass(input.constructor);
          if (own && own !== type && own.isA(rt))
            return this.forType(own.name)(input, undefined, context);
        } else if (this.options.profiles !== false) {
          const profiles = input.meta?.profile;
          if (Array.isArray(profiles)) {
            // decoded by the first profile it names; checked against the others
            const found: FhirTypeInfo[] = [];
            for (const url of profiles) {
              if (typeof url !== 'string') continue;
              const p = model.findProfile(url);
              if (p && p.kind === 'profile' && p.isA(rt) && !found.includes(p))
                found.push(p);
            }
            if (found.length) {
              const out = this.forType(found[0].name)(
                input,
                undefined,
                context,
              );
              for (const p of found.slice(1))
                this.forType(p.name)(input, undefined, context);
              return out;
            }
          }
        }
        return this.forType(rt)(input, undefined, context);
      },
    );
    this._resources.set(base, codec);
    return codec;
  }
}
