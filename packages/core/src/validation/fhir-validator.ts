import { FhirPath, FhirPathError } from '@fhirjs/fhirpath';
import type { FhirIssue } from '../codec/types.js';
import {
  type FhirModel,
  type FhirTypeInfo,
  FhirValueSet,
} from '../fhir-model.js';
import { fhirPathModelOf } from '../fhirpath/fhirpath-model.js';
import type { FhirConstraintOptions } from '../types.js';

const isObject = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Runs the invariants (FHIRPath constraints) of a resource's types, their
 * bases and its profiles, on every node of the resource.
 */
export class FhirInvariants {
  readonly fhirPath: FhirPath;

  constructor(readonly model: FhirModel) {
    this.fhirPath = new FhirPath({
      model: fhirPathModelOf(model),
      // R4 invariants (que-7, dom-3) lean on lenient typing
      lenient: true,
      memberOf: (value, url) => memberOf(model.getValueSet(url), value),
    });
  }

  /**
   * The issues of a resource (in its JSON form) against the invariants of
   * `types`: its own type and the profiles it is checked against
   */
  check(
    json: Record<string, any>,
    types: FhirTypeInfo[],
    root = 'Resource',
  ): FhirIssue[] {
    const issues: FhirIssue[] = [];
    const seen = new Set<string>();
    for (const type of types)
      this._walk(json, type, json, json, root, issues, seen);
    return issues;
  }

  private _evaluate(
    c: FhirConstraintOptions,
    node: unknown,
    type: string,
    resource: unknown,
    root: unknown,
    where: string,
    issues: FhirIssue[],
    seen: Set<string>,
  ) {
    if (!c.expression) return;
    const id = where + '\u0000' + c.key;
    if (seen.has(id)) return; // a base's invariant met again through a profile
    seen.add(id);
    let result: boolean | undefined;
    try {
      result = this.fhirPath
        .compile(c.expression)
        .test(node, { type, resource, rootResource: root });
    } catch (e) {
      const message =
        e instanceof FhirPathError || e instanceof SyntaxError
          ? e.message
          : String(e);
      issues.push({
        severity: 'warning',
        code: 'exception',
        expression: where,
        diagnostics: `${c.key} could not be evaluated: ${message}`,
      });
      return;
    }
    if (result !== false) return; // true, or nothing to test
    issues.push({
      severity: c.severity === 'warning' ? 'warning' : 'error',
      code: 'invariant',
      expression: where,
      diagnostics: `${c.key}: ${c.human}`,
    });
  }

  private _walk(
    node: Record<string, any>,
    type: FhirTypeInfo,
    root: unknown,
    resource: unknown,
    where: string,
    issues: FhirIssue[],
    seen: Set<string>,
  ) {
    // a contained resource has no narrative of its own: dom-6 is not for it
    const contained = resource !== root;
    for (let t: FhirTypeInfo | undefined = type; t; t = t.base)
      for (const c of t.constraints)
        if (!(contained && c.key === 'dom-6'))
          this._evaluate(
            c,
            node,
            type.path,
            resource,
            root,
            where,
            issues,
            seen,
          );

    for (const el of type.elements.values()) {
      for (const et of el.types) {
        const v = node[et.key];
        if (v === undefined || v === null) continue;
        const items: unknown[] = Array.isArray(v) ? v : [v];
        const target = this.model.getType(et.code);
        items.forEach((item, i) => {
          if (item === undefined || item === null) return;
          const at = `${where}.${et.key}${Array.isArray(v) ? `[${i}]` : ''}`;
          for (const c of el.constraints)
            this._evaluate(c, item, et.code, resource, root, at, issues, seen);
          if (!isObject(item) || target.kind === 'primitive-type') return;
          if (target.kind === 'resource') {
            const rt =
              typeof item.resourceType === 'string' &&
              this.model.hasType(item.resourceType)
                ? this.model.getType(item.resourceType)
                : undefined;
            if (!rt) return;
            // contained: %rootResource stays the container; a Bundle entry is its own root
            const contained = et.key === 'contained';
            this._walk(
              item,
              rt,
              contained ? root : item,
              item,
              at,
              issues,
              seen,
            );
            return;
          }
          this._walk(item, target, root, resource, at, issues, seen);
        });
      }
    }
  }
}

/** Whether a code, Coding or CodeableConcept is in a value set; undefined when its codes are not known */
function memberOf(
  vs: FhirValueSet | undefined,
  value: unknown,
): boolean | undefined {
  if (!vs) return;
  if (typeof value === 'string') return vs.has(value);
  if (!isObject(value)) return;
  const codings: any[] = Array.isArray(value.coding) ? value.coding : [value];
  return codings.some(
    c =>
      isObject(c) &&
      typeof c.code === 'string' &&
      vs.has(c.code, typeof c.system === 'string' ? c.system : undefined),
  );
}
