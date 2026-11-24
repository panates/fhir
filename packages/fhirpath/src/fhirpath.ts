import type { FhirPathNode } from './ast.js';
import {
  checkExpression,
  type FhirPathCheckOptions,
  type FhirPathIssue,
} from './check.js';
import {
  type EvalContext,
  type FhirPathEnv,
  type Fn,
  toBool,
} from './context.js';
import { compile } from './evaluate.js';
import type { FhirPathModel } from './model.js';
import { parse } from './parser.js';
import { FpQuantity, FpTemporal, Item } from './values.js';

export interface FhirPathOptions {
  /** The FHIR model navigation and type tests use; without one, JSON keys */
  model?: FhirPathModel;
  /** resolve() of a reference that is not contained or in the Bundle evaluated */
  resolve?: (reference: string) => unknown;
  /** memberOf(): whether a code, Coding or CodeableConcept is in a value set; undefined: not known */
  memberOf?: (value: unknown, valueSet: string) => boolean | undefined;
  /** trace(): where traced values go; nothing by default */
  trace?: (name: string, values: unknown[]) => void;
  /**
   * Lenient typing, for invariants written against it: a FHIR primitive is
   * also its System type (`active.is(Boolean)`), and `as` takes a collection.
   * Strict, as the specification says, by default.
   */
  lenient?: boolean;
  /**
   * conformsTo(): whether a value conforms to a profile (by its canonical
   * url); undefined when not known. Core StructureDefinitions need no help:
   * conforming to one is being of its type.
   */
  conformsTo?: (value: unknown, url: string) => boolean | undefined;
}

export interface FhirPathEvaluateOptions {
  /**
   * The type of the input: a resource type, a data type, or a backbone path
   * ('Patient.contact'). A resource's own resourceType when not given.
   */
  type?: string;
  /** %resource: the resource the input belongs to (default: the input, when it is one) */
  resource?: unknown;
  /** %rootResource: the outermost resource (default: %resource) */
  rootResource?: unknown;
  /** Other %variables, by name without % */
  vars?: Record<string, unknown>;
  /** now(), today(): the time of the evaluation (default: when it runs) */
  now?: Date;
}

const toItems = (v: unknown, type?: string): Item[] => {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.map(x =>
    x instanceof Item
      ? x
      : new Item(
          x,
          type ??
            (x &&
            typeof x === 'object' &&
            typeof (x as any).resourceType === 'string'
              ? (x as any).resourceType
              : undefined),
        ),
  );
};

/** An item's value as given back: dates as their text, quantities as { value, unit } */
const fromItem = (i: Item): unknown =>
  i.v instanceof FpTemporal
    ? i.v.text
    : i.v instanceof FpQuantity
      ? { value: i.v.value, unit: i.v.unit }
      : (i.v ?? null);

/** A parsed and compiled expression */
export class FhirPathExpression {
  constructor(
    readonly expression: string,
    readonly ast: FhirPathNode,
    private readonly fn: Fn,
    private readonly owner: FhirPath,
  ) {}

  /** The items the expression gives (values with their types) */
  evaluateItems(input: unknown, options: FhirPathEvaluateOptions = {}): Item[] {
    const focus = toItems(input, options.type);
    const resource =
      options.resource ??
      (focus.length === 1 && focus[0].v?.resourceType ? focus[0].v : undefined);
    const vars: Record<string, Item[]> = { context: focus };
    if (resource !== undefined) vars.resource = toItems(resource);
    const root = options.rootResource ?? resource;
    if (root !== undefined) vars.rootResource = toItems(root);
    if (options.vars)
      for (const [k, v] of Object.entries(options.vars)) vars[k] = toItems(v);
    const o = this.owner.options;
    const env: FhirPathEnv = {
      model: o.model,
      vars,
      resolve: o.resolve ? ref => o.resolve!(ref) : undefined,
      memberOf: o.memberOf,
      trace: o.trace,
      now: options.now ?? new Date(),
      lenient: o.lenient,
      conformsTo: o.conformsTo,
    };
    const ctx: EvalContext = { env, focus };
    return this.fn(ctx);
  }

  /**
   * Checks the expression against the type of its input, without data:
   * unknown elements and types, functions given what they do not take, order
   * on an unordered collection. Empty when nothing is found.
   */
  check(options: FhirPathCheckOptions = {}): FhirPathIssue[] {
    return this._check(options).issues;
  }

  /**
   * The types the expression's items may have, as check() infers them
   * ('System.String', 'HumanName'); undefined when it cannot tell
   */
  typeOf(options: FhirPathCheckOptions = {}): string[] | undefined {
    return this._check(options).types;
  }

  private _check(options: FhirPathCheckOptions) {
    return checkExpression(this.ast, this.owner.options.model, {
      lenient: this.owner.options.lenient,
      ...options,
    });
  }

  /** The values the expression gives */
  evaluate(input: unknown, options?: FhirPathEvaluateOptions): unknown[] {
    return this.evaluateItems(input, options).map(fromItem);
  }

  /**
   * The expression as a condition (an invariant): true or false, undefined
   * when it gives nothing
   */
  test(input: unknown, options?: FhirPathEvaluateOptions): boolean | undefined {
    return toBool(this.evaluateItems(input, options), this.expression);
  }
}

/**
 * A FHIRPath engine: compiles expressions (cached) and evaluates them over
 * FHIR resources, with the model given.
 */
export class FhirPath {
  private readonly _cache = new Map<string, FhirPathExpression>();

  constructor(readonly options: FhirPathOptions = {}) {}

  /** Parses and compiles an expression; throws FhirPathSyntaxError or FhirPathError */
  compile(expression: string): FhirPathExpression {
    let e = this._cache.get(expression);
    if (!e) {
      const ast = parse(expression);
      e = new FhirPathExpression(expression, ast, compile(ast), this);
      this._cache.set(expression, e);
    }
    return e;
  }

  /** Evaluates an expression over an input (a resource, an element, a collection) */
  evaluate(
    input: unknown,
    expression: string,
    options?: FhirPathEvaluateOptions,
  ): unknown[] {
    return this.compile(expression).evaluate(input, options);
  }

  /** Checks an expression against the type of its input; see FhirPathExpression.check() */
  check(expression: string, options?: FhirPathCheckOptions): FhirPathIssue[] {
    return this.compile(expression).check(options);
  }
}
