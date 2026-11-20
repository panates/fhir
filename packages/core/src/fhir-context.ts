import { FhirCodecError } from './codec/fhir-codec-error.js';
import { FhirCodecs } from './codec/fhir-codecs.js';
import type { FhirIssue } from './codec/types.js';
import type { FhirCodecMode, FhirCodecOptions } from './codec/types.js';
import { parseFhirJson } from './decimal.js';
import { getOwnTypeMetadata } from './decorators.js';
import type { FhirModel, FhirPackageReport, FhirTypeInfo } from './fhir-model.js';
import type { FhirPackage } from './package/fhir-package.js';
import { resourceTypeOf } from './resource-type.js';
import { FhirInvariants } from './validation/fhir-validator.js';

export interface FhirValidateOptions extends FhirCodecOptions {
  /** Run the invariants (FHIRPath constraints) of the types and profiles (default true) */
  invariants?: boolean;
  /**
   * Profiles to check against besides those meta.profile names: canonical
   * URLs or type names of profiles the model has
   */
  profile?: string | string[];
  /** Keep warnings in the result (default true) */
  warnings?: boolean;
}

export interface FhirValidationResult {
  /** No issue of severity error or fatal */
  valid: boolean;
  /** Structure, bindings, profiles (the codec), then invariants */
  issues: FhirIssue[];
  /** The instance read (from JSON), or the one given; undefined when it could not be read */
  value?: any;
  /** The issues as an OperationOutcome resource */
  outcome(): Record<string, any>;
}

type TypeArg<T> = string | (abstract new (...args: any[]) => T);

/**
 * A FHIR version's model with the codecs built on it: reads resources from
 * their JSON form into class instances (decode) and writes them back
 * (encode).
 */
export class FhirContext {
  private readonly _codecs = new Map<string, FhirCodecs>();

  readonly model: FhirModel;
  readonly options: FhirCodecOptions;
  /** What loading each package gave: counts and warnings */
  readonly packageReports: FhirPackageReport[] = [];

  constructor(
    model: FhirModel,
    options: FhirCodecOptions & {
      /**
       * Profiles, extension definitions and other classes to add: the
       * context gets its own model, the given one is not changed
       */
      types?: Function[];
      /** Implementation guides: their profiles, extensions and value sets */
      packages?: FhirPackage[];
    } = {},
  ) {
    const { types, packages, ...codecOptions } = options;
    this.model = types?.length || packages?.length ? model.extend(types || []) : model;
    for (const pkg of packages || []) this.packageReports.push(this.model.loadPackage(pkg));
    this.options = codecOptions;
  }

  /**
   * Reads a resource (or a data type, when `type` names one) from JSON text
   * or a parsed JSON object. Without `type`, the class is the one of its
   * resourceType. Throws FhirCodecError.
   */
  decode<T = any>(
    input: string | object,
    type?: TypeArg<T>,
    options?: FhirCodecOptions,
  ): T {
    const json =
      typeof input === 'string'
        ? (options?.decimals ?? this.options.decimals) === 'number'
          ? JSON.parse(input)
          : parseFhirJson(input)
        : input;
    const name = typeof type === 'function' ? this._nameOf(type) : type;
    return this.codecs('decode', options).run(name, json);
  }

  /** Writes a resource or data type in its JSON form. Throws FhirCodecError. */
  encode(
    value: object,
    type?: TypeArg<any>,
    options?: FhirCodecOptions,
  ): Record<string, any> {
    let name = typeof type === 'function' ? this._nameOf(type) : type;
    if (!name) {
      const ctor = (value as any).constructor;
      if (ctor && ctor !== Object && getOwnTypeMetadata(ctor))
        name = this._nameOf(ctor);
    }
    return this.codecs('encode', options).run(name, value);
  }

  /**
   * Checks a resource (JSON text, a JSON object or an instance) against
   * everything the model knows: its structure, cardinality and required
   * bindings, its profiles (meta.profile, and `profile`), the extensions it
   * uses, and the invariants of its types and profiles. Does not throw for an
   * invalid resource: the result lists the issues.
   */
  validate(
    input: string | object,
    type?: TypeArg<any>,
    options: FhirValidateOptions = {},
  ): FhirValidationResult {
    const { invariants, profile, warnings, ...codecOptions } = options;
    const issues: FhirIssue[] = [];
    const collect = (fn: () => any) => {
      try {
        return fn();
      } catch (e) {
        if (!(e instanceof FhirCodecError)) throw e;
        issues.push(...e.issues);
        return undefined;
      }
    };
    let json: any = typeof input === 'string' ? parseFhirJson(input) : input;
    const ctor = json?.constructor;
    const isInstance = ctor && ctor !== Object && !!getOwnTypeMetadata(ctor);
    let value: any;
    const typeName = typeof type === 'function' ? this._nameOf(type) : type;

    // Profiles to check against: those given, and those meta.profile names
    const profileTypes: FhirTypeInfo[] = [];
    const addProfile = (ref: string) => {
      const t = ref.includes('/') ? this.model.findProfile(ref) : this.model.hasType(ref) ? this.model.getType(ref) : undefined;
      if (t && t.isProfile && !profileTypes.includes(t)) profileTypes.push(t);
    };
    for (const p of typeof profile === 'string' ? [profile] : profile || []) addProfile(p);

    if (isInstance) {
      value = json;
      json = collect(() => this.encode(json, type, codecOptions));
    } else {
      value = collect(() => this.decode(json, typeName ?? profileTypes[0]?.name, codecOptions));
    }
    // a profile given that decoding did not use: its structure too
    for (const p of profileTypes.slice(isInstance ? 0 : typeName ? 0 : 1))
      if (json && typeof json === 'object') collect(() => this.codecs('decode', codecOptions).run(p.name, json));

    if (invariants !== false && json && typeof json === 'object' && typeof json.resourceType === 'string') {
      for (const url of Array.isArray(json.meta?.profile) ? json.meta.profile : [])
        if (typeof url === 'string') addProfile(url);
      const base = typeName ? this.model.getType(typeName) : this.model.hasType(json.resourceType) ? this.model.getType(json.resourceType) : undefined;
      const types = profileTypes.filter(p => !base || p.isA(base.profileOf?.name ?? base.name));
      if (base && !types.length) types.push(base);
      if (types.length) issues.push(...this.invariants.check(json, types, json.resourceType));
    }

    const kept = warnings === false ? issues.filter(i => i.severity !== 'warning' && i.severity !== 'information') : issues;
    return {
      valid: !kept.some(i => i.severity === 'error' || i.severity === 'fatal'),
      issues: kept,
      value,
      outcome: () => ({
        resourceType: 'OperationOutcome',
        issue: kept.length
          ? kept.map(i => ({ severity: i.severity, code: i.code, diagnostics: i.diagnostics, expression: [i.expression] }))
          : [{ severity: 'information', code: 'informational', diagnostics: 'No issues' }],
      }),
    };
  }

  /** The invariants of the model, run with its FHIRPath (cached) */
  get invariants(): FhirInvariants {
    return (this._invariants ||= new FhirInvariants(this.model));
  }
  private _invariants?: FhirInvariants;

  /** encode() as JSON text */
  stringify(
    value: object,
    options?: FhirCodecOptions & { space?: number | string },
  ): string {
    return JSON.stringify(
      this.encode(value, undefined, { ...options, rawDecimals: true }),
      null,
      options?.space,
    );
  }

  /** The codecs of a mode and option set (cached) */
  codecs(mode: FhirCodecMode, options?: FhirCodecOptions): FhirCodecs {
    const merged = { ...this.options, ...options };
    const key =
      mode +
      ':' +
      (merged.unknownElements || 'error') +
      (merged.partial ? ':partial' : '') +
      (merged.plain ? ':plain' : '') +
      (merged.bindings === false ? ':nobindings' : '') +
      (merged.rawDecimals ? ':raw' : '') +
      (merged.profiles === false ? ':noprofiles' : '') +
      (merged.extensions === false ? ':noextensions' : '');
    let codecs = this._codecs.get(key);
    if (!codecs) {
      codecs = new FhirCodecs(this.model, mode, merged);
      this._codecs.set(key, codecs);
    }
    return codecs;
  }

  private _nameOf(ctor: Function): string {
    for (
      let c = ctor;
      c && c !== Function.prototype;
      c = Object.getPrototypeOf(c)
    ) {
      if (this.model.hasType(c)) return this.model.getType(c).name;
    }
    const rt = resourceTypeOf(ctor);
    if (rt) return rt;
    throw new TypeError(`${ctor.name} is not a type of this model`);
  }
}
