import type { FhirPathChild, FhirPathModel } from '@fhirjs/fhirpath';
import type { FhirModel, FhirTypeInfo } from '../fhir-model.js';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The primitives that specialize another (their StructureDefinition's base):
 * a code is a string, a url a uri. The generated classes do not extend each
 * other, so FHIRPath's is() learns it here.
 */
const PRIMITIVE_BASE: Record<string, string> = {
  code: 'string',
  id: 'string',
  markdown: 'string',
  url: 'uri',
  canonical: 'uri',
  oid: 'uri',
  uuid: 'uri',
  positiveInt: 'integer',
  unsignedInt: 'integer',
};

/**
 * The FhirPathModel of a FhirModel: FHIRPath navigates and tests types with
 * the same definitions as the codec (generated classes, profiles, packages).
 */
export function fhirPathModelOf(model: FhirModel): FhirPathModel {
  let m = adapters.get(model);
  if (!m) adapters.set(model, (m = new ModelAdapter(model)));
  return m;
}

const adapters = new WeakMap<FhirModel, FhirPathModel>();

class ModelAdapter implements FhirPathModel {
  private readonly _children = new Map<
    string,
    readonly FhirPathChild[] | null
  >();
  private readonly _all = new Map<string, readonly FhirPathChild[]>();

  constructor(private readonly model: FhirModel) {}

  /** A type by name, or by backbone path ('Patient.contact' is PatientContact) */
  private _type(type: string): FhirTypeInfo | undefined {
    const m = this.model;
    if (m.hasType(type)) return m.getType(type);
    if (type.includes('.')) {
      const name = type.split('.').map(cap).join('');
      if (m.hasType(name)) return m.getType(name);
    }
    return;
  }

  getChildren(
    type: string,
    name: string,
  ): readonly FhirPathChild[] | undefined {
    const key = type + '\u0000' + name;
    let c = this._children.get(key);
    if (c === undefined) {
      const t = this._type(type);
      const el = t?.elements.get(name) ?? t?.elements.get(name + '[x]');
      c = el ? el.types.map(et => ({ key: et.key, type: et.code })) : null;
      this._children.set(key, c);
    }
    return c ?? undefined;
  }

  allChildren(type: string): readonly FhirPathChild[] {
    let c = this._all.get(type);
    if (!c) {
      const t = this._type(type);
      c = t
        ? [...t.elements.values()].flatMap(el =>
            el.types.map(et => ({ key: et.key, type: et.code })),
          )
        : [];
      this._all.set(type, c);
    }
    return c;
  }

  hasType(type: string): boolean {
    return !!this._type(type);
  }

  isType(type: string, base: string): boolean {
    const t = this._type(type);
    if (!t) return false;
    if (t.isA(base)) return true;
    for (let p = PRIMITIVE_BASE[type]; p; p = PRIMITIVE_BASE[p])
      if (p === base) return true;
    return false;
  }

  isAbstract(type: string): boolean {
    return !!this._type(type)?.abstract;
  }

  isPrimitive(type: string): boolean {
    return this._type(type)?.kind === 'primitive-type';
  }
}
