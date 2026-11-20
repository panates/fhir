import { FHIR_METADATA } from './constants.js';
import type {
  FhirBackboneTypeOptions,
  FhirConstraintOptions,
  FhirElementOptions,
  FhirExtensionOptions,
  FhirExtensionTypeOptions,
  FhirPrimitiveTypeOptions,
  FhirProfileOptions,
  FhirSliceOptions,
  FhirTypeKind,
  FhirTypeMetadata,
  FhirTypeOptions,
} from './types.js';

/*
 * The decorators only record their options on the class. The model reads
 * them when a type is first used (FhirModel), so importing classes stays cheap.
 */

/** The metadata a class itself carries (not its base class's) */
export function getOwnTypeMetadata(
  ctor: Function,
): FhirTypeMetadata | undefined {
  return Object.hasOwn(ctor, FHIR_METADATA)
    ? (ctor as any)[FHIR_METADATA]
    : undefined;
}

function ownMetadata(ctor: Function): FhirTypeMetadata {
  let meta = getOwnTypeMetadata(ctor);
  if (!meta) {
    meta = {
      kind: undefined as unknown as FhirTypeKind,
      elements: {},
      constraints: [],
      elementConstraints: {},
      extensions: {},
      slices: {},
    };
    Object.defineProperty(ctor, FHIR_METADATA, { value: meta });
  }
  return meta;
}

function typeDecorator(kind: FhirTypeKind, options?: object): ClassDecorator {
  return target => {
    const meta = ownMetadata(target);
    meta.kind = kind;
    Object.assign(meta, options);
    meta.name = meta.name || (kind === 'backbone' ? undefined : target.name);
  };
}

/** A resource: Patient, Observation; abstract ones are Resource, DomainResource */
export function FhirResource(options?: FhirTypeOptions): ClassDecorator {
  return typeDecorator('resource', options);
}

/** A data type: HumanName, Quantity, Element, BackboneElement */
export function FhirComplexType(options?: FhirTypeOptions): ClassDecorator {
  return typeDecorator('complex-type', options);
}

/** The content of an element defined in place: Patient.contact */
export function FhirBackboneType(
  options: FhirBackboneTypeOptions,
): ClassDecorator {
  return typeDecorator('backbone', options);
}

/** A primitive type: string, date, decimal */
export function FhirPrimitiveType(
  options: FhirPrimitiveTypeOptions,
): ClassDecorator {
  return typeDecorator('primitive-type', options);
}

/**
 * A profile on the class it extends: tightens inherited elements
 * (@FhirElement with only what changes), adds extension and slice properties
 */
export function FhirProfile(options: FhirProfileOptions): ClassDecorator {
  return typeDecorator('profile', options);
}

/** An extension definition, on a class extending Extension */
export function FhirExtensionType(
  options: FhirExtensionTypeOptions,
): ClassDecorator {
  return typeDecorator('extension', options);
}

/** A property that is an extension entry on the wire */
export function FhirExtension(
  options: FhirExtensionOptions,
): PropertyDecorator {
  return (target, propertyKey) => {
    if (typeof propertyKey !== 'string')
      throw new TypeError('A FHIR extension property must have a string name');
    ownMetadata(target.constructor).extensions[propertyKey] = options;
  };
}

/** A property that is one slice of a repeating element of the base */
export function FhirSlice(options: FhirSliceOptions): PropertyDecorator {
  return (target, propertyKey) => {
    if (typeof propertyKey !== 'string')
      throw new TypeError('A FHIR slice property must have a string name');
    ownMetadata(target.constructor).slices[propertyKey] = options;
  };
}

/** An element of the type */
export function FhirElement(options: FhirElementOptions): PropertyDecorator {
  return (target, propertyKey) => {
    if (typeof propertyKey !== 'string')
      throw new TypeError('A FHIR element must have a string name');
    ownMetadata(target.constructor).elements[propertyKey] = options;
  };
}

/**
 * An invariant: on a class, of the type; on a property, of that element.
 * Repeatable.
 */
export function FhirConstraint(
  options: FhirConstraintOptions,
): ClassDecorator & PropertyDecorator {
  return ((target: any, propertyKey?: string | symbol) => {
    if (propertyKey === undefined) {
      ownMetadata(target).constraints.unshift(options);
      return;
    }
    if (typeof propertyKey !== 'string')
      throw new TypeError('A FHIR element must have a string name');
    const meta = ownMetadata(target.constructor);
    (meta.elementConstraints[propertyKey] ||= []).unshift(options);
  }) as ClassDecorator & PropertyDecorator;
}
