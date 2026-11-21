import { getOwnTypeMetadata } from './decorators.js';
import type { FhirPackage } from './package/fhir-package.js';
import { ProfileBuilder } from './package/profile-builder.js';
import { type FhirSearchParameter, searchParameterOf } from './search-parameter.js';
import {
  codeSystemCodes,
  resolveValueSet,
  type ValueSetEntries,
} from './package/value-set-resolver.js';
import type {
  FhirBindingOptions,
  FhirBindingStrength,
  FhirConstraintOptions,
  FhirDataSlicing,
  FhirElementOptions,
  FhirTypeKind,
  FhirTypeMetadata,
  FhirTypeRef,
} from './types.js';

const BINDING_RANK: Record<FhirBindingStrength, number> = {
  required: 3,
  extensible: 2,
  preferred: 1,
  example: 0,
};

/** A property that is an extension entry on the wire */
export interface FhirExtensionInfo {
  property: string;
  /** Absolute, or relative ('code') for a part of a complex extension */
  url: string;
  min: number;
  max: number;
  isArray: boolean;
  /** In modifierExtension */
  modifier: boolean;
  /** Its definition class (@FhirExtensionType), when it has one */
  definition?: FhirTypeInfo;
  /** A complex extension: its value is an instance of the definition */
  complex: boolean;
  /** A simple one: the type of its value[x] */
  valueType?: string;
  binding?: FhirBindingOptions;
}

/** A property that is one slice of a repeating element */
export interface FhirSliceInfo {
  property: string;
  name: string;
  element: FhirElementInfo;
  min: number;
  max: number;
  isArray: boolean;
  pattern: unknown;
  /** Type of the items */
  itemType: string;
}

function maxOf(v: number | '*' | undefined, dflt = 1): number {
  return v === '*' ? Infinity : v == null ? dflt : v;
}

/** One allowed type of an element */
export interface FhirElementTypeInfo {
  /** Type name: 'HumanName', 'string', 'PatientContact' */
  code: string;
  /** JSON key of this type: 'deceasedBoolean', or the element's name */
  key: string;
  /** The property holding it */
  property: string;
  targets?: string[];
}

/** An element of a type, built from its decorated properties */
export class FhirElementInfo {
  readonly isArray: boolean;
  readonly types: FhirElementTypeInfo[] = [];
  readonly min: number;
  readonly max: number;
  readonly binding?: FhirBindingOptions;
  readonly summary: boolean;
  readonly modifier: boolean;
  readonly mustSupport: boolean;
  readonly noExtension: boolean;
  readonly fixed?: unknown;
  readonly pattern?: unknown;
  readonly description?: string;
  readonly constraints: FhirConstraintOptions[] = [];

  constructor(
    readonly owner: FhirTypeInfo,
    /** 'name', or 'deceased[x]' for a choice */
    readonly name: string,
    options: FhirElementOptions,
  ) {
    this.min = options.min ?? 0;
    this.max =
      options.max === '*' ? Infinity : options.max == null ? 1 : options.max;
    this.isArray = this.max > 1;
    this.binding = options.binding;
    this.summary = !!options.summary;
    this.modifier = !!options.modifier;
    this.mustSupport = !!options.mustSupport;
    this.noExtension = !!options.noExtension;
    this.fixed = options.fixed;
    this.pattern = options.pattern;
    this.description = options.description;
  }

  /** 'Patient.name' */
  get path(): string {
    return this.owner.path + '.' + this.name;
  }

  get isChoice(): boolean {
    return this.name.endsWith('[x]');
  }

  /** The definition of one of its types (the first by default) */
  getType(index = 0): FhirTypeInfo {
    const t = this.types[index];
    if (!t) throw new RangeError(`${this.path} has no type #${index}`);
    return this.owner.model.getType(t.code);
  }
}

/** A type of the model: its kind, base and elements (own and inherited) */
export class FhirTypeInfo {
  readonly kind: FhirTypeKind;
  readonly name: string;
  readonly url?: string;
  readonly abstract: boolean;
  readonly description?: string;
  readonly regex?: string;
  readonly json?: 'string' | 'number' | 'boolean';
  readonly base?: FhirTypeInfo;
  readonly constraints: FhirConstraintOptions[];
  /** By element name ('deceased[x]'), own and inherited, base first */
  readonly elements = new Map<string, FhirElementInfo>();
  /** By JSON key ('deceasedBoolean', 'name') */
  readonly keys = new Map<string, FhirElementInfo>();
  /** Extension properties, own and inherited */
  readonly extensions = new Map<string, FhirExtensionInfo>();
  /** Slice properties, own and inherited */
  readonly slices = new Map<string, FhirSliceInfo>();
  /** For a profile or extension definition: the type it constrains */
  readonly profileOf?: FhirTypeInfo;
  /** An extension definition's context */
  readonly context?: string[];
  /** Slicing of a profile read from a StructureDefinition */
  readonly dataSlices: FhirDataSlicing[] = [];
  private readonly _path?: string;

  constructor(
    readonly model: FhirModel,
    readonly ctor: Function,
    meta: FhirTypeMetadata,
    /** The type it is built on, for a type without its own class */
    base?: FhirTypeInfo,
  ) {
    this.kind = meta.kind;
    this._path = meta.path;
    this.name = meta.name || pathToName(meta.path!);
    this.url = meta.url;
    this.abstract = !!meta.abstract;
    this.description = meta.description;
    this.regex = meta.regex;
    this.json = meta.json;
    this.constraints = meta.constraints;

    this.context = meta.context;
    const isProfile = meta.kind === 'profile' || meta.kind === 'extension';

    const baseCtor = Object.getPrototypeOf(ctor);
    if (base) this.base = base;
    else if (baseCtor && baseCtor !== Function.prototype && getOwnTypeMetadata(baseCtor)?.kind)
      this.base = model.getType(baseCtor);
    if (isProfile) {
      if (!this.base) throw new TypeError(`${this.name}: a profile must extend a FHIR type`);
      this.profileOf = this.base.profileOf || this.base;
      if (meta.kind === 'extension' && !this.profileOf.isA('Extension'))
        throw new TypeError(`${this.name}: an extension definition must extend Extension`);
      if (!this.url && !base) throw new TypeError(`${this.name}: a profile needs a url`);
    }
    if (this.base) {
      for (const [name, el] of this.base.elements) this.elements.set(name, el);
      for (const [key, el] of this.base.keys) this.keys.set(key, el);
      for (const [p, x] of this.base.extensions) this.extensions.set(p, x);
      for (const [p, x] of this.base.slices) this.slices.set(p, x);
    }
    if (meta.dataSlicing) this.dataSlices.push(...meta.dataSlicing);

    // A simple extension definition narrows value[x] to its type
    const elementOptions = { ...meta.elements };
    if (meta.kind === 'extension' && meta.value) {
      const valueType = model.resolveTypeName(meta.value.type);
      const key = 'value' + valueType.charAt(0).toUpperCase() + valueType.slice(1);
      elementOptions[key] = {
        type: valueType,
        choice: 'value[x]',
        min: 1,
        binding: meta.value.binding,
        ...elementOptions[key],
      };
    }

    for (const [property, options] of Object.entries(elementOptions)) {
      if (isProfile) {
        this._constrain(property, options);
        const own = meta.elementConstraints[property];
        if (own) this.keys.get(property)?.constraints.push(...own);
        continue;
      }
      if (!options.type) throw new TypeError(`${this.name}.${property}: no type`);
      const name = options.choice || property;
      let el = this.elements.get(name);
      if (!el || el.owner !== this) {
        el = new FhirElementInfo(this, name, options);
        this.elements.set(name, el);
      }
      el.types.push({
        code: model.resolveTypeName(options.type),
        key: property,
        property,
        targets: options.targets,
      });
      this.keys.set(property, el);
      const constraints = meta.elementConstraints[property];
      if (constraints) el.constraints.push(...constraints);
    }

    for (const [property, options] of Object.entries(meta.extensions)) {
      if (this.keys.has(property))
        throw new TypeError(`${this.name}.${property}: an extension property cannot have an element's name`);
      let definition: FhirTypeInfo | undefined;
      let url = options.url;
      let valueType = options.type ? model.resolveTypeName(options.type) : undefined;
      let binding = options.binding;
      if (options.extension) {
        definition = model.getType(options.extension());
        if (definition.kind !== 'extension')
          throw new TypeError(`${this.name}.${property}: ${definition.name} is not an extension definition`);
        url = definition.url;
        const value = definition.elements.get('value[x]');
        const allowed = value && definition.elements.get('value[x]') !== definition.base?.elements.get('value[x]');
        if (allowed && value!.types.length === 1) {
          valueType = value!.types[0].code;
          binding = binding || value!.binding;
        }
      }
      if (!url) throw new TypeError(`${this.name}.${property}: an extension needs a url or a definition`);
      const complex = !!definition && !valueType;
      if (!complex && !valueType)
        throw new TypeError(`${this.name}.${property}: an extension needs a value type`);
      const max = maxOf(options.max);
      this.extensions.set(property, {
        property,
        url,
        min: options.min ?? 0,
        max,
        isArray: max > 1,
        modifier: !!options.modifier,
        definition,
        complex,
        valueType,
        binding,
      });
    }

    for (const [property, options] of Object.entries(meta.slices)) {
      if (!isProfile) throw new TypeError(`${this.name}.${property}: slices belong to profiles`);
      const element = this.elements.get(options.element);
      if (!element) throw new TypeError(`${this.name}.${property}: no element "${options.element}" to slice`);
      if (!element.isArray) throw new TypeError(`${this.name}.${property}: ${options.element} does not repeat`);
      if (element.types.length !== 1)
        throw new TypeError(`${this.name}.${property}: ${options.element} has more than one type`);
      const max = maxOf(options.max);
      if (max > element.max)
        throw new TypeError(`${this.name}.${property}: slice max ${max} exceeds ${element.path} max ${element.max}`);
      this.slices.set(property, {
        property,
        name: options.name,
        element,
        min: options.min ?? 0,
        max,
        isArray: max > 1,
        pattern: options.pattern,
        itemType: element.types[0].code,
      });
    }
  }

  /**
   * A profile's @FhirElement on an inherited element: merges over it, and
   * may only tighten it
   */
  private _constrain(property: string, options: FhirElementOptions): void {
    // a choice narrowed by several keys: the later ones are gone from keys
    const base = this.keys.get(property) || this.base?.keys.get(property);
    const where = `${this.name}.${property}`;
    if (!base) throw new TypeError(`${where}: a profile cannot add elements, only constrain them`);
    const min = options.min ?? base.min;
    const max = options.max === undefined ? base.max : maxOf(options.max);
    if (min < base.min) throw new TypeError(`${where}: min ${min} is below the base's ${base.min}`);
    if (max > base.max) throw new TypeError(`${where}: max ${max} is above the base's ${base.max}`);
    if (min > max) throw new TypeError(`${where}: min ${min} is above max ${max}`);
    const binding = options.binding ?? base.binding;
    if (options.binding && base.binding && BINDING_RANK[options.binding.strength] < BINDING_RANK[base.binding.strength])
      throw new TypeError(`${where}: binding ${options.binding.strength} is weaker than the base's ${base.binding.strength}`);

    // Narrowing a choice: the types of the decorated keys only
    let types = base.types;
    if (options.type) {
      const code = this.model.resolveTypeName(options.type);
      const t = base.types.find(x => x.key === property);
      // the base's type, or a profile of it
      if (!t || (t.code !== code && !this.model.getType(code).isA(t.code)))
        throw new TypeError(`${where}: type ${code} is not a type of ${base.path}`);
      const narrowed = t.code === code ? t : { ...t, code };
      const prev = this.elements.get(base.name);
      types = prev && prev.owner === this ? [...prev.types, narrowed] : [narrowed];
    }

    const el = new FhirElementInfo(this, base.name, {
      min,
      max: max === Infinity ? '*' : max,
      binding,
      summary: base.summary,
      modifier: base.modifier,
      mustSupport: options.mustSupport ?? base.mustSupport,
      noExtension: base.noExtension,
      fixed: options.fixed ?? base.fixed,
      pattern: options.pattern ?? base.pattern,
      description: options.description ?? base.description,
    });
    // the array shape follows the base (a 0..1 slice of 0..* stays an array)
    (el as { isArray: boolean }).isArray = base.isArray;
    el.types.push(...types);
    el.constraints.push(...base.constraints);
    for (const t of base.types) this.keys.delete(t.key);
    for (const t of el.types) this.keys.set(t.key, el);
    this.elements.set(base.name, el);
  }

  /** 'Patient', or 'Patient.contact' for a backbone type */
  get path(): string {
    return this._path || this.name;
  }

  /** An element by its name ('deceased[x]') or JSON key ('deceasedBoolean') */
  getElement(nameOrKey: string): FhirElementInfo | undefined {
    return this.elements.get(nameOrKey) || this.keys.get(nameOrKey);
  }

  isA(name: string): boolean {
    for (let t: FhirTypeInfo | undefined = this; t; t = t.base)
      if (t.name === name) return true;
    return false;
  }

  /** A profile, or an extension definition */
  get isProfile(): boolean {
    return this.kind === 'profile' || this.kind === 'extension';
  }
}

/** 'Patient.contact' -> 'PatientContact' */
function pathToName(path: string): string {
  return path
    .split('.')
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

/**
 * The types of one FHIR version, from their decorated classes. A type is
 * built from its decorators the first time it is asked for.
 */
export class FhirModel {
  private readonly _ctors = new Map<string, Function>();
  private readonly _types = new Map<Function, FhirTypeInfo>();
  private readonly _valueSetData = new Map<string, Record<string, string[]>>();
  private readonly _valueSets = new Map<string, FhirValueSet>();
  private readonly _profiles = new Map<string, Function>();
  /** Types without a class: profiles read from StructureDefinitions */
  private readonly _defs = new Map<string, FhirTypeInfo>();
  private readonly _defProfiles = new Map<string, string>();
  /** StructureDefinitions of loaded packages, built on first use */
  private readonly _sds = new Map<string, any>();
  /** Loaded packages: their value sets and code systems are read when used */
  private _sources: FhirPackage[] = [];
  /** Value sets and code systems read from the packages; null: cannot be listed */
  private readonly _vsFromPackages = new Map<string, ValueSetEntries | null>();
  private readonly _csFromPackages = new Map<string, string[] | null>();
  private readonly _resolving = new Set<string>();
  private readonly _building = new Set<string>();
  /** Search parameters by base type, then by code */
  private readonly _searchParams = new Map<string, Map<string, FhirSearchParameter>>();
  private _warnings: string[] = [];

  constructor(
    /** '4.0.1' */
    readonly fhirVersion: string,
    classes: Iterable<Function>,
    options?: {
      /** Codes of value sets by canonical URL: code system -> codes */
      valueSets?: Record<string, Record<string, string[]>>;
      /** The search parameters of the version */
      searchParameters?: Iterable<FhirSearchParameter>;
    },
  ) {
    for (const ctor of classes) this.addClass(ctor);
    if (options?.valueSets) this.addValueSets(options.valueSets);
    if (options?.searchParameters) this.addSearchParameters(options.searchParameters);
  }

  /** Adds search parameters; one with the code of an earlier one on the same base replaces it */
  addSearchParameters(params: Iterable<FhirSearchParameter>): void {
    for (const p of params)
      for (const base of p.base) {
        let byCode = this._searchParams.get(base);
        if (!byCode) this._searchParams.set(base, (byCode = new Map()));
        byCode.set(p.code, p);
      }
  }

  /**
   * The search parameters of a resource type, its base types' included
   * (Resource's _id): by code, the type's own first
   */
  searchParameters(type: string): Map<string, FhirSearchParameter> {
    const out = new Map<string, FhirSearchParameter>();
    if (!this.hasType(type)) return out;
    for (let t: FhirTypeInfo | undefined = this.getType(type); t; t = t.base) {
      const own = this._searchParams.get(t.name);
      if (own) for (const [code, p] of own) if (!out.has(code)) out.set(code, p);
    }
    return out;
  }

  /** A search parameter of a resource type by its code ('birthdate', '_id') */
  getSearchParameter(type: string, code: string): FhirSearchParameter | undefined {
    return this.searchParameters(type).get(code);
  }

  /** Adds or replaces value sets: canonical URL -> code system -> codes */
  addValueSets(data: Record<string, Record<string, string[]>>): void {
    for (const [url, entries] of Object.entries(data)) {
      this._valueSetData.set(url, entries);
      this._valueSets.delete(url);
    }
  }

  /**
   * A value set whose codes the model has or can list from a loaded package,
   * by canonical URL (a |version suffix is ignored); undefined otherwise.
   * A package's value set is read and listed the first time it is asked for.
   */
  getValueSet(url: string): FhirValueSet | undefined {
    const bar = url.indexOf('|');
    if (bar >= 0) url = url.slice(0, bar);
    let vs = this._valueSets.get(url);
    if (!vs) {
      const data = this._entriesOf(url);
      if (!data) return;
      vs = new FhirValueSet(url, data);
      this._valueSets.set(url, vs);
    }
    return vs;
  }

  private _entriesOf(url: string): ValueSetEntries | undefined {
    const data = this._valueSetData.get(url);
    if (data) return data;
    const cached = this._vsFromPackages.get(url);
    if (cached !== undefined) return cached ?? undefined;
    if (this._resolving.has(url)) return; // a value set including itself
    let resource: any;
    // the package loaded last first: an IG before its dependencies
    for (let i = this._sources.length - 1; i >= 0 && !resource; i--)
      resource = this._sources[i].findResource('ValueSet', url);
    if (!resource) {
      this._vsFromPackages.set(url, null);
      return;
    }
    this._resolving.add(url);
    try {
      const entries = resolveValueSet(resource, {
        valueSet: u => this._entriesOf(u),
        codeSystem: u => this._codeSystemCodes(u),
      });
      this._vsFromPackages.set(url, entries ?? null);
      return entries;
    } finally {
      this._resolving.delete(url);
    }
  }

  private _codeSystemCodes(url: string): string[] | undefined {
    const cached = this._csFromPackages.get(url);
    if (cached !== undefined) return cached ?? undefined;
    let resource: any;
    for (let i = this._sources.length - 1; i >= 0 && !resource; i--)
      resource = this._sources[i].findResource('CodeSystem', url);
    const codes = resource ? codeSystemCodes(resource) : undefined;
    this._csFromPackages.set(url, codes ?? null);
    return codes;
  }

  /** Registers a decorated class; a later class of the same name replaces it */
  addClass(ctor: Function): void {
    const meta = getOwnTypeMetadata(ctor);
    if (!meta?.kind) throw new TypeError(`${ctor.name} is not a FHIR type`);
    const name = meta.name || pathToName(meta.path!);
    this._ctors.set(name, ctor);
    this._types.delete(ctor);
    if ((meta.kind === 'profile' || meta.kind === 'extension') && meta.url)
      this._profiles.set(meta.url, ctor);
  }

  /**
   * A new model with this one's classes and value sets, and the given
   * classes (profiles, extension definitions, replacements) added
   */
  extend(classes: Iterable<Function>): FhirModel {
    const model = new FhirModel(this.fhirVersion, this._ctors.values());
    for (const [url, entries] of this._valueSetData) model._valueSetData.set(url, entries);
    for (const [url, sd] of this._sds) model._sds.set(url, sd);
    model._sources = [...this._sources];
    for (const [url, e] of this._vsFromPackages) model._vsFromPackages.set(url, e);
    for (const [url, c] of this._csFromPackages) model._csFromPackages.set(url, c);
    for (const [base, byCode] of this._searchParams) model._searchParams.set(base, new Map(byCode));
    for (const ctor of classes) model.addClass(ctor);
    return model;
  }

  /**
   * A profile or extension definition by its canonical URL: a registered
   * class, or one read from a loaded package
   */
  findProfile(url: string): FhirTypeInfo | undefined {
    const bar = url.indexOf('|');
    if (bar >= 0) url = url.slice(0, bar);
    const ctor = this._profiles.get(url);
    if (ctor) return this.getType(ctor);
    const name = this._defProfiles.get(url);
    if (name) return this._defs.get(name);
    const sd = this._sds.get(url);
    if (!sd || this._building.has(url)) return;
    this._building.add(url);
    try {
      const built = new ProfileBuilder(this, sd, m => this._warnings.push(m)).build();
      return this._defs.get(built);
    } catch (e) {
      this._warnings.push(`${url}: ${(e as Error).message}`);
      this._sds.delete(url);
      return;
    } finally {
      this._building.delete(url);
    }
  }

  /**
   * Registers a type without a class, built on `base` (instances are of the
   * base's class); returns its name, made unique
   */
  addDefinition(meta: FhirTypeMetadata, base: FhirTypeInfo): string {
    let name = meta.name || base.name;
    for (let i = 2; this._ctors.has(name) || this._defs.has(name); i++)
      name = `${meta.name || base.name}_${i}`;
    meta.name = name;
    const info = new FhirTypeInfo(this, base.ctor, meta, base);
    this._defs.set(name, info);
    if (meta.url) this._defProfiles.set(meta.url, name);
    return name;
  }

  /**
   * Loads an implementation guide's package: the codes of its value sets,
   * and its profiles and extension definitions (from their snapshots). A
   * definition that cannot be read is reported in the result, not thrown.
   */
  loadPackage(pkg: FhirPackage): FhirPackageReport {
    const warnings: string[] = [];
    const prev = this._warnings;
    this._warnings = warnings;
    try {
      if (pkg.fhirVersions.length && !pkg.fhirVersions.some(v => v.startsWith(this.fhirVersion.slice(0, 3))))
        warnings.push(`${pkg.id} is for FHIR ${pkg.fhirVersions.join(', ')}, this model is ${this.fhirVersion}`);
      // value sets and code systems: read when a binding needs them
      this._sources.push(pkg);
      // a value set or code system of the package may be one not found before
      for (const [url, e] of this._vsFromPackages) if (e === null) this._vsFromPackages.delete(url);
      for (const [url, c] of this._csFromPackages) if (c === null) this._csFromPackages.delete(url);
      const urls: string[] = [];
      const bound = new Set<string>();
      for (const entry of pkg.entriesOf('StructureDefinition')) {
        // A type the model already has from its generated classes (the core
        // package's Patient, string ...): not read
        if (entry.type && entry.id === entry.type && this.hasType(entry.type)) continue;
        const sd = pkg.resourceOf(entry);
        if (!sd) continue;
        for (const ed of sd.snapshot?.element || [])
          if (ed.binding?.strength === 'required' && typeof ed.binding.valueSet === 'string')
            bound.add(ed.binding.valueSet.split('|')[0]);
        if (sd.derivation !== 'constraint' || !sd.url) continue;
        if (!sd.snapshot?.element?.length) {
          warnings.push(`${sd.url}: no snapshot, not loaded`);
          continue;
        }
        if (!this.hasType(sd.type)) {
          warnings.push(`${sd.url}: unknown type ${sd.type}, not loaded`);
          continue;
        }
        this._sds.set(sd.url, sd);
        urls.push(sd.url);
      }
      let profiles = 0;
      let extensions = 0;
      for (const url of urls) {
        const t = this.findProfile(url);
        if (t?.kind === 'extension') extensions++;
        else if (t) profiles++;
      }
      // its search parameters, after those the model has (an IG's replace a core one of its
      // code). A FHIR core package adds none: the model has its parameters from the generated
      // classes, and its examples (SearchParameter/example) would replace real ones.
      const params: FhirSearchParameter[] = [];
      const isCore = /^hl7\.fhir\.r[0-9]+b?\.core$/.test(pkg.name);
      for (const entry of isCore ? [] : pkg.entriesOf('SearchParameter')) {
        const p = searchParameterOf(pkg.resourceOf(entry));
        if (!p) continue;
        const unknown = p.base.filter(b => !this.hasType(b));
        if (unknown.length) {
          warnings.push(`${p.url}: unknown base ${unknown.join(', ')}, not loaded`);
          continue;
        }
        params.push(p);
      }
      this.addSearchParameters(params);
      // the value sets the package's required bindings use, listed now
      const notListed = [...bound].filter(url => !this.getValueSet(url));
      return {
        package: pkg.id,
        profiles,
        extensions,
        searchParameters: params.length,
        valueSets: bound.size - notListed.length,
        valueSetsNotListed: notListed,
        warnings,
      };
    } finally {
      this._warnings = prev;
    }
  }

  /** The registered type of a class, when the class is one */
  typeOfClass(ctor: unknown): FhirTypeInfo | undefined {
    if (typeof ctor !== 'function' || !getOwnTypeMetadata(ctor)?.kind) return;
    return this.hasType(ctor) ? this.getType(ctor) : undefined;
  }

  hasType(nameOrCtor: string | Function): boolean {
    return typeof nameOrCtor === 'string'
      ? this._ctors.has(nameOrCtor) || this._defs.has(nameOrCtor)
      : !!getOwnTypeMetadata(nameOrCtor)?.kind &&
          this._ctors.get(this._nameOf(nameOrCtor)) === nameOrCtor;
  }

  getType(nameOrCtor: string | Function): FhirTypeInfo {
    if (typeof nameOrCtor === 'string') {
      const def = this._defs.get(nameOrCtor);
      if (def) return def;
    }
    const ctor =
      typeof nameOrCtor === 'string' ? this._ctors.get(nameOrCtor) : nameOrCtor;
    if (!ctor) throw new TypeError(`Unknown FHIR type "${nameOrCtor}"`);
    let info = this._types.get(ctor);
    if (!info) {
      const meta = getOwnTypeMetadata(ctor);
      if (!meta?.kind) throw new TypeError(`${ctor.name} is not a FHIR type`);
      const name = meta.name || pathToName(meta.path!);
      if (!this._ctors.has(name)) this.addClass(ctor);
      info = new FhirTypeInfo(this, ctor, meta);
      this._types.set(ctor, info);
    }
    return info;
  }

  /** Names of every registered type */
  typeNames(): IterableIterator<string> {
    return this._ctors.keys();
  }

  /** Names of the concrete resources */
  resourceTypes(): string[] {
    const out: string[] = [];
    for (const [name, ctor] of this._ctors) {
      const meta = getOwnTypeMetadata(ctor)!;
      if (meta.kind === 'resource' && !meta.abstract) out.push(name);
    }
    return out;
  }

  /** The type name an element option refers to */
  resolveTypeName(ref: FhirTypeRef): string {
    return typeof ref === 'string' ? ref : this._nameOf(ref());
  }

  private _nameOf(ctor: Function): string {
    const meta = getOwnTypeMetadata(ctor);
    if (!meta?.kind) throw new TypeError(`${ctor.name} is not a FHIR type`);
    return meta.name || pathToName(meta.path!);
  }
}

/** The codes of a value set, by code system */
export class FhirValueSet {
  private readonly _bySystem = new Map<string, Set<string>>();
  private readonly _all = new Set<string>();

  constructor(
    readonly url: string,
    entries: Record<string, string[]>,
  ) {
    for (const [system, codes] of Object.entries(entries)) {
      this._bySystem.set(system, new Set(codes));
      for (const c of codes) this._all.add(c);
    }
  }

  /** Code systems of the value set */
  get systems(): string[] {
    return [...this._bySystem.keys()];
  }

  /** Whether the value set has the code (in the system, when given) */
  has(code: string, system?: string): boolean {
    return system === undefined
      ? this._all.has(code)
      : !!this._bySystem.get(system)?.has(code);
  }
}

/** What loading a package gave */
export interface FhirPackageReport {
  /** 'hl7.fhir.us.core#6.1.0' */
  package: string;
  profiles: number;
  extensions: number;
  /** SearchParameter resources of the package added to the model */
  searchParameters: number;
  /** Value sets of the package's required bindings whose codes are known */
  valueSets: number;
  /**
   * Value sets of its required bindings that cannot be listed (a filter, a
   * package not loaded): those bindings are not checked
   */
  valueSetsNotListed: string[];
  warnings: string[];
}
