import type {
  FhirElementInfo,
  FhirModel,
  FhirTypeInfo,
} from '../fhir-model.js';
import type {
  FhirConstraintOptions,
  FhirDataSlice,
  FhirDataSlicing,
  FhirElementOptions,
  FhirTypeMetadata,
} from '../types.js';

const FHIR_TYPE_EXT =
  'http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type';
const SYSTEM_PREFIX = 'http://hl7.org/fhirpath/System.';

const maxOf = (max: string | undefined): number | undefined =>
  max === undefined ? undefined : max === '*' ? Infinity : Number(max);

/** The fixed[x] or pattern[x] value of an ElementDefinition */
function fixedOrPattern(ed: any): { fixed?: unknown; pattern?: unknown } {
  const out: { fixed?: unknown; pattern?: unknown } = {};
  for (const k of Object.keys(ed)) {
    if (k.startsWith('fixed') && k.length > 5) out.fixed = ed[k];
    else if (k.startsWith('pattern') && k.length > 7) out.pattern = ed[k];
  }
  return out;
}

function typeCode(t: any): string {
  // R4 writes a few System types as _code with a json-type extension: a string
  if (typeof t.code !== 'string') return 'string';
  return t.code.startsWith(SYSTEM_PREFIX)
    ? t.extension?.find((x: any) => x.url === FHIR_TYPE_EXT)?.valueUrl ||
        'string'
    : t.code;
}

function getAt(o: unknown, path: string): unknown {
  let v: any = o;
  for (const seg of path.split('.')) {
    if (v == null) return;
    v = Array.isArray(v) ? v[0]?.[seg] : v[seg];
  }
  return v;
}

function setAt(o: Record<string, any>, path: string, value: unknown): void {
  const segs = path.split('.');
  let t = o;
  for (let i = 0; i < segs.length - 1; i++) t = t[segs[i]] ||= {};
  t[segs[segs.length - 1]] = value;
}

/**
 * Builds the types of a profile (or an extension definition) from the
 * snapshot of its StructureDefinition: one type for the profile and one for
 * every element whose content it constrains (Patient.identifier.system 1..1
 * makes a constrained Identifier). Types have no class of their own:
 * instances are of the base type's class.
 */
export class ProfileBuilder {
  private readonly byId = new Map<string, any>();
  private readonly children = new Map<string, any[]>();

  constructor(
    private readonly model: FhirModel,
    private readonly sd: any,
    private readonly warn: (message: string) => void,
  ) {
    for (const ed of sd.snapshot.element) {
      this.byId.set(ed.id, ed);
      const dot = ed.id.lastIndexOf('.');
      if (dot < 0) continue;
      const parent = ed.id.slice(0, dot);
      let list = this.children.get(parent);
      if (!list) this.children.set(parent, (list = []));
      list.push(ed);
    }
  }

  /**
   * The element at a path below an element, through slices on the way:
   * code.coding.code finds Observation.component:SystolicBP.code.coding:SBPCode.code
   */
  private findBelow(id: string, path: string): any {
    const exact = this.byId.get(`${id}.${path}`);
    if (exact) return exact;
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      '^' +
        esc(id) +
        path
          .split('.')
          .map(seg => `\\.${esc(seg)}(?::[^.]+)?`)
          .join('') +
        '$',
    );
    for (const [key, ed] of this.byId) {
      if (!re.test(key)) continue;
      const fp = fixedOrPattern(ed);
      if (fp.fixed !== undefined || fp.pattern !== undefined) return ed;
    }
    return undefined;
  }

  /** The invariants an element of this profile adds: no source, or the profile's own */
  private ownConstraints(ed: any): FhirConstraintOptions[] {
    const out: FhirConstraintOptions[] = [];
    for (const c of ed?.constraint || []) {
      if (c.source && c.source !== this.sd.url) continue;
      if (typeof c.key !== 'string' || typeof c.expression !== 'string')
        continue;
      out.push({
        key: c.key,
        severity: c.severity === 'warning' ? 'warning' : 'error',
        human: c.human ?? '',
        expression: c.expression,
      });
    }
    return out;
  }

  /** Builds and registers the profile; returns its type name */
  build(): string {
    const { sd, model } = this;
    const base = model.getType(sd.type);
    const kind = sd.type === 'Extension' ? 'extension' : 'profile';
    const name = this.level(base, sd.type, sd.name, { kind, url: sd.url });
    return name!;
  }

  /**
   * The type for the content of the element with this id, when the profile
   * constrains it (always for the root); undefined when it does not
   */
  private level(
    baseType: FhirTypeInfo,
    id: string,
    name: string,
    root?: { kind: 'profile' | 'extension'; url: string },
  ): string | undefined {
    const elements: Record<string, FhirElementOptions> = {};
    const elementConstraints: Record<string, FhirConstraintOptions[]> = {};
    const dataSlicing: FhirDataSlicing[] = [];
    const kids = this.children.get(id) || [];
    const constraints = this.ownConstraints(this.byId.get(id));

    for (const ed of kids) {
      const seg = ed.id.slice(id.length + 1);
      if (seg.includes(':')) continue; // slices: below, with their element
      const el = baseType.getElement(seg);
      if (!el) {
        if (ed.max !== '0')
          this.warn(
            `${this.sd.url}: ${ed.id} is not an element of ${baseType.name}`,
          );
        continue;
      }
      Object.assign(elements, this.element(baseType, el, ed, `${name}.${seg}`));
      // invariants on a primitive element stay with the element; on a complex
      // one, they are the constrained type's (element() made one for them)
      const own = this.ownConstraints(ed);
      if (
        own.length &&
        el.types.every(
          t => this.model.getType(t.code).kind === 'primitive-type',
        )
      ) {
        const key = el.types[0].key;
        elements[key] ??= {};
        elementConstraints[key] = own;
      }

      if (ed.slicing) {
        const slicing = this.slicing(baseType, el, ed, kids, name);
        if (slicing) dataSlicing.push(slicing);
      }
    }

    if (
      !root &&
      !Object.keys(elements).length &&
      !dataSlicing.length &&
      !constraints.length
    )
      return;
    const meta: FhirTypeMetadata = {
      kind: root?.kind || 'profile',
      name,
      url: root?.url,
      elements,
      constraints,
      elementConstraints,
      extensions: {},
      slices: {},
      dataSlicing: dataSlicing.length ? dataSlicing : undefined,
    };
    return this.model.addDefinition(meta, baseType);
  }

  /** Options for the JSON keys of an element the profile changes */
  private element(
    baseType: FhirTypeInfo,
    el: FhirElementInfo,
    ed: any,
    name: string,
  ): Record<string, FhirElementOptions> {
    const diff: FhirElementOptions = {};
    if (ed.min > el.min) diff.min = ed.min;
    const max = maxOf(ed.max);
    if (max !== undefined && max < el.max)
      diff.max = max === Infinity ? '*' : max;
    const vs = ed.binding?.valueSet;
    if (
      vs &&
      (!el.binding ||
        el.binding.strength !== ed.binding.strength ||
        el.binding.valueSet.split('|')[0] !== vs.split('|')[0])
    )
      diff.binding = { strength: ed.binding.strength, valueSet: vs };
    Object.assign(diff, fixedOrPattern(ed));

    // Types kept (a choice may be narrowed), and constrained content
    const codes: string[] = Array.isArray(ed.type)
      ? ed.type.map(typeCode)
      : el.types.map(t => t.code);
    const kept = el.types.filter(
      t => codes.includes(t.code) || el.types.length === 1,
    );
    const narrowed = el.isChoice && kept.length < el.types.length;
    const out: Record<string, FhirElementOptions> = {};
    let changedType = false;
    const typed: Record<string, string> = {};
    for (const t of kept) {
      const target = this.model.getType(t.code);
      let type: string | undefined;
      // A choice constrained per type: value[x]:valueQuantity
      const typeSliceId = el.isChoice ? `${ed.id}:${t.key}` : undefined;
      const contentId =
        typeSliceId && this.byId.has(typeSliceId) ? typeSliceId : ed.id;
      if (target.kind !== 'primitive-type' && target.kind !== 'resource')
        type = this.level(
          target,
          contentId,
          el.isChoice ? `${name}:${t.key}` : name,
        );
      if (!type) {
        const profileUrl = ed.type?.find((x: any) => typeCode(x) === t.code)
          ?.profile?.[0];
        const p = profileUrl ? this.model.findProfile(profileUrl) : undefined;
        if (p && p.isA(t.code)) type = p.name;
      }
      if (type) {
        changedType = true;
        typed[t.key] = type;
      }
    }
    if (!narrowed && !changedType) {
      if (Object.keys(diff).length) out[el.types[0].key] = diff;
      return out;
    }
    for (const t of kept)
      out[t.key] = { ...diff, type: typed[t.key] || t.code };
    return out;
  }

  /** The slicing of an element: its slices, with a pattern from the discriminators */
  private slicing(
    baseType: FhirTypeInfo,
    el: FhirElementInfo,
    ed: any,
    siblings: any[],
    name: string,
  ): FhirDataSlicing | undefined {
    if (el.isChoice) return; // type slices of a choice: handled as its types
    const discriminators: any[] = ed.slicing.discriminator || [];
    const slices: FhirDataSlice[] = [];
    const itemType = this.model.getType(el.types[0].code);
    for (const s of siblings) {
      if (!s.id.startsWith(ed.id + ':')) continue;
      const seg: string = s.id.slice(ed.id.length);
      if (seg.includes('/') || seg.slice(1).includes(':')) continue;
      const sliceName = s.sliceName || seg.slice(1);
      const pattern: Record<string, any> = {};
      let valueSet: string | undefined;
      for (const d of discriminators) {
        let v: unknown;
        if (d.type === 'value' || d.type === 'pattern') {
          if (d.path === '$this') {
            const fp = fixedOrPattern(s);
            v = fp.fixed ?? fp.pattern;
          } else if (d.path === 'url' && itemType.isA('Extension')) {
            v =
              fixedOrPattern(this.byId.get(`${s.id}.url`) || {}).fixed ??
              s.type?.[0]?.profile?.[0];
          } else {
            const child = this.findBelow(s.id, d.path);
            const fp = child ? fixedOrPattern(child) : {};
            v = fp.fixed ?? fp.pattern;
            if (v === undefined) {
              const own = fixedOrPattern(s);
              v = getAt(own.fixed ?? own.pattern, d.path);
            }
          }
        } else if (
          d.type === 'type' &&
          (d.path === '$this' || d.path === 'resource')
        ) {
          const code = s.type?.[0]?.code;
          v = code;
          if (v !== undefined) {
            if (d.path === '$this') setAt(pattern, 'resourceType', v);
            else setAt(pattern, 'resource.resourceType', v);
            continue;
          }
        } else {
          this.warn(
            `${this.sd.url}: ${ed.id} slices by ${d.type} (${d.path}): not supported, slicing not checked`,
          );
          return;
        }
        if (v === undefined && d.path === '$this' && s.binding?.valueSet) {
          // sliced by the value set its codes are in
          if (!this.model.getValueSet(s.binding.valueSet)) {
            this.warn(
              `${this.sd.url}: ${s.id} is sliced by the value set ${s.binding.valueSet}, whose codes are not known: slicing not checked`,
            );
            return;
          }
          valueSet = s.binding.valueSet;
          continue;
        }
        if (v === undefined) {
          this.warn(
            `${this.sd.url}: ${s.id} has no value for discriminator ${d.path}: slicing not checked`,
          );
          return;
        }
        if (d.path === '$this') {
          if (v && typeof v === 'object') Object.assign(pattern, v);
          else return; // a primitive slice by value: not supported
        } else setAt(pattern, d.path, v);
      }
      let sliceType: string | undefined;
      if (itemType.isA('Extension')) {
        const url = s.type?.[0]?.profile?.[0];
        sliceType = url ? this.model.findProfile(url)?.name : undefined;
      }
      if (
        !sliceType &&
        itemType.kind !== 'primitive-type' &&
        itemType.kind !== 'resource'
      )
        sliceType = this.level(
          itemType,
          s.id,
          `${name}.${el.name}:${sliceName}`,
        );
      slices.push({
        name: sliceName,
        min: s.min ?? 0,
        max: maxOf(s.max) ?? Infinity,
        pattern,
        valueSet,
        itemType: sliceType,
      });
    }
    if (!slices.length && ed.slicing.rules !== 'closed') return;
    return {
      element: el.types[0].key,
      rules: ed.slicing.rules || 'open',
      slices,
    };
  }
}
