import type { FhirContext, FhirTypeInfo } from '@fhirjs/core';
import { FhirServerError } from './fhir-server-error.js';

/** The part of each resource a read or a search gives: `_summary` or `_elements` */
export interface Subset {
  /** _summary: 'true', 'text', 'data' or 'count'; 'false' is no subset */
  summary?: 'true' | 'text' | 'data' | 'count';
  /** _elements: the top-level elements asked for, by resource type; '*' for every type */
  elements?: Map<string, Set<string>>;
}

const SUMMARIES = new Set(['true', 'false', 'text', 'data', 'count']);

/** The tag a resource given in part carries */
export const SUBSETTED = {
  system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationValue',
  code: 'SUBSETTED',
  display: 'Subsetted',
};

/**
 * `_summary` and `_elements` of a request, read: undefined when neither asks
 * for a part. `type` is the type read or searched: an element of `_elements`
 * without a type (`name`) is one of every type, `Patient.name` one of
 * Patient only. Throws 400 for a value it cannot read, and, when strict, for
 * an element the type does not have.
 */
export function subsetOf(
  params: URLSearchParams,
  fhir: FhirContext,
  type: string,
  strict: boolean,
): Subset | undefined {
  const summaries = params.getAll('_summary');
  const elements = params
    .getAll('_elements')
    .flatMap(v => v.split(','))
    .map(v => v.trim())
    .filter(v => v);
  if (summaries.length > 1)
    throw new FhirServerError(400, '_summary is given more than once', 'value');
  const summary = summaries[0];
  if (summary !== undefined && !SUMMARIES.has(summary))
    throw new FhirServerError(
      400,
      `_summary: "${summary}" is not one of true, false, text, data, count`,
      'value',
    );
  if (summary !== undefined && summary !== 'false' && elements.length)
    throw new FhirServerError(
      400,
      '_summary and _elements cannot be used together',
      'not-supported',
    );
  if (summary !== undefined && summary !== 'false')
    return { summary: summary as Subset['summary'] };
  if (!elements.length) return;
  const model = fhir.model;
  const out = new Map<string, Set<string>>();
  for (const item of elements) {
    const dot = item.indexOf('.');
    const of = dot < 0 ? '*' : item.slice(0, dot);
    const name = (dot < 0 ? item : item.slice(dot + 1)).replace(/\[x\]$/, '');
    const known =
      of === '*' || model.resourceTypes().includes(of)
        ? hasElement(model.getType(of === '*' ? type : of), name)
        : false;
    if (!known) {
      if (strict)
        throw new FhirServerError(
          400,
          `_elements: ${of === '*' ? type : of} has no element ${name}`,
          'value',
        );
      continue;
    }
    if (!out.has(of)) out.set(of, new Set());
    out.get(of)!.add(name);
  }
  // none known: the whole resource, as without _elements
  return out.size ? { elements: out } : undefined;
}

/**
 * `_elements` of a Bulk Data export, read for the types it exports: an
 * element without a type (`id`) is one of every type that has it,
 * `Patient.name` one of Patient only. Throws 400, when strict, for an
 * element no type exported has. Undefined when none is known.
 */
export function exportSubset(
  elements: readonly string[],
  types: readonly string[],
  fhir: FhirContext,
  strict: boolean,
): Subset | undefined {
  const model = fhir.model;
  const out = new Map<string, Set<string>>();
  for (const item of elements) {
    const dot = item.indexOf('.');
    const of = dot < 0 ? '*' : item.slice(0, dot);
    const name = (dot < 0 ? item : item.slice(dot + 1)).replace(/\[x\]$/, '');
    const known =
      of === '*'
        ? types.some(t => hasElement(model.getType(t), name))
        : types.includes(of) && hasElement(model.getType(of), name);
    if (!known) {
      if (strict)
        throw new FhirServerError(
          400,
          of === '*'
            ? `$export: _elements: no type exported has an element ${name}`
            : `$export: _elements: ${of} is not exported, or has no element ${name}`,
          'value',
        );
      continue;
    }
    if (!out.has(of)) out.set(of, new Set());
    out.get(of)!.add(name);
  }
  return out.size ? { elements: out } : undefined;
}

/** A resource as a subset asks for it, tagged SUBSETTED; the resource itself when the subset keeps it whole */
export function subsetted(
  resource: Record<string, any>,
  subset: Subset,
  fhir: FhirContext,
): Record<string, any> {
  const type = fhir.model.getType(resource.resourceType);
  let out: Record<string, any>;
  if (subset.elements) {
    const asked = new Set([
      ...(subset.elements.get('*') ?? []),
      ...(subset.elements.get(resource.resourceType) ?? []),
    ]);
    out = pick(
      resource,
      type,
      el => asked.has(el.name.replace(/\[x\]$/, '')) || el.min > 0,
    );
  } else if (subset.summary === 'true') out = summaryOf(resource, type);
  else if (subset.summary === 'text')
    out = pick(resource, type, el => el.name === 'text' || el.min > 0);
  else if (subset.summary === 'data')
    out = pick(resource, type, el => el.name !== 'text');
  else return resource;
  const meta = { ...(out.meta ?? {}) };
  meta.tag = [...(meta.tag ?? []), SUBSETTED];
  return { ...out, meta };
}

function hasElement(type: FhirTypeInfo, name: string): boolean {
  return !!(type.elements.get(name) ?? type.elements.get(`${name}[x]`));
}

/** The keys of an object whose element passes; resourceType, id and meta always */
function pick(
  value: Record<string, any>,
  type: FhirTypeInfo,
  keep: (el: NonNullable<ReturnType<FhirTypeInfo['getElement']>>) => boolean,
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === 'resourceType' || key === 'id' || key === 'meta') {
      out[key] = v;
      continue;
    }
    // _birthDate: the extensions of a primitive go with it
    const el = type.getElement(key.startsWith('_') ? key.slice(1) : key);
    if (el && keep(el)) out[key] = v;
  }
  return out;
}

/** The summary elements, and those of backbone elements within them */
function summaryOf(
  value: Record<string, any>,
  type: FhirTypeInfo,
): Record<string, any> {
  const out = pick(value, type, el => el.summary);
  for (const [key, v] of Object.entries(out)) {
    const el = type.getElement(key);
    if (!el || el.types.length !== 1) continue;
    const t = el.getType();
    if (t.kind !== 'backbone') continue;
    out[key] = Array.isArray(v)
      ? v.map(x => (x && typeof x === 'object' ? summaryOf(x, t) : x))
      : v && typeof v === 'object'
        ? summaryOf(v, t)
        : v;
  }
  return out;
}
