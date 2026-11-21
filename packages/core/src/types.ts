/**
 * A type an element refers to: a type name the model resolves ('HumanName',
 * 'string'), or a thunk returning a class (for developer types that import
 * their element classes).
 */
export type FhirTypeRef = string | (() => Function);

export type FhirTypeKind =
  | 'primitive-type'
  | 'complex-type'
  | 'backbone'
  | 'resource'
  /** Constrains the type it extends (@FhirProfile) */
  | 'profile'
  /** An extension definition: a profile on Extension (@FhirExtensionType) */
  | 'extension';

export type FhirBindingStrength =
  | 'required'
  | 'extensible'
  | 'preferred'
  | 'example';

export interface FhirBindingOptions {
  strength: FhirBindingStrength;
  /** Canonical URL of the value set, with or without |version */
  valueSet: string;
}

export interface FhirConstraintOptions {
  /** 'pat-1' */
  key: string;
  severity: 'error' | 'warning';
  human: string;
  /** FHIRPath expression, evaluated on the element it is declared on */
  expression?: string;
}

export interface FhirElementOptions {
  /**
   * The element's type; for a choice, the type of this one property. In a
   * profile, given only to narrow the types of the base element.
   */
  type?: FhirTypeRef;
  /** Allowed target resources of a Reference or canonical ('Patient', 'Group') */
  targets?: string[];
  /** Default 0 */
  min?: number;
  /** Default 1 */
  max?: number | '*';
  /**
   * The choice element this property is one type of: 'deceased[x]' on
   * deceasedBoolean and deceasedDateTime
   */
  choice?: string;
  binding?: FhirBindingOptions;
  summary?: boolean;
  modifier?: boolean;
  mustSupport?: boolean;
  /**
   * A primitive that cannot carry an id or extensions: no `_x` sibling in JSON
   * (Element.id, Extension.url, Resource.id)
   */
  noExtension?: boolean;
  fixed?: unknown;
  pattern?: unknown;
  description?: string;
}

export interface FhirTypeOptions {
  /** Defaults to the class name */
  name?: string;
  /** Canonical URL of the StructureDefinition */
  url?: string;
  abstract?: boolean;
  description?: string;
}

export interface FhirBackboneTypeOptions {
  /** The element path the type is the content of: 'Patient.contact' */
  path: string;
  description?: string;
}

export interface FhirPrimitiveTypeOptions extends FhirTypeOptions {
  name: string;
  /** Regex of the value, from the specification */
  regex?: string;
  /** How a value is written in JSON */
  json: 'string' | 'number' | 'boolean';
}

export interface FhirProfileOptions {
  /** Canonical URL of the profile; written to meta.profile */
  url: string;
  /** Defaults to the class name */
  name?: string;
  description?: string;
}

export interface FhirExtensionTypeOptions {
  /** Canonical URL of the extension */
  url: string;
  /** Defaults to the class name */
  name?: string;
  description?: string;
  /** Where it may be used: 'Patient', 'Patient.contact' */
  context?: string[];
  /** A simple extension: the type of its value[x]. Absent: a complex one */
  value?: { type: FhirTypeRef; binding?: FhirBindingOptions };
}

/**
 * A property that is an extension on the wire: its value in code, an entry
 * of `extension` (or `modifierExtension`) in JSON
 */
export interface FhirExtensionOptions {
  /** The extension's definition (@FhirExtensionType); gives url and type */
  extension?: () => Function;
  /**
   * The extension's URL, when it has no definition class; relative ('code')
   * for a part of a complex extension
   */
  url?: string;
  /** The value's type, when it has no definition class */
  type?: FhirTypeRef;
  binding?: FhirBindingOptions;
  /** Default 0 */
  min?: number;
  /** Default 1 */
  max?: number | '*';
  /** In modifierExtension */
  modifier?: boolean;
}

/** A property that is one slice of a repeating element of the base */
export interface FhirSliceOptions {
  /** The sliced element: 'identifier' */
  element: string;
  /** The slice's name in the profile */
  name: string;
  /** Default 0 */
  min?: number;
  /** Default 1 */
  max?: number | '*';
  /**
   * What an item of the slice has (the discriminator): an item matches when
   * it has every value of the pattern. Filled into items when encoding.
   */
  pattern: unknown;
}

/** What the decorators store on a class */
export interface FhirTypeMetadata {
  kind: FhirTypeKind;
  name?: string;
  url?: string;
  path?: string;
  abstract?: boolean;
  description?: string;
  regex?: string;
  json?: 'string' | 'number' | 'boolean';
  /** By property name, in declaration order */
  elements: Record<string, FhirElementOptions>;
  constraints: FhirConstraintOptions[];
  /** Constraints on an element, by property name */
  elementConstraints: Record<string, FhirConstraintOptions[]>;
  /** Extension properties, by property name */
  extensions: Record<string, FhirExtensionOptions>;
  /** Slice properties, by property name */
  slices: Record<string, FhirSliceOptions>;
  /** An extension definition's context and value */
  context?: string[];
  value?: FhirExtensionTypeOptions['value'];
  /** Slicing of a profile read from a StructureDefinition (no properties) */
  dataSlicing?: FhirDataSlicing[];
}

/** The slicing of a repeating element, as a StructureDefinition gives it */
export interface FhirDataSlicing {
  /** The sliced element: 'category', 'extension' */
  element: string;
  /** closed: every item must be in a slice */
  rules: 'open' | 'closed' | 'openAtEnd';
  slices: FhirDataSlice[];
}

export interface FhirDataSlice {
  name: string;
  min: number;
  max: number;
  /** What an item of the slice has: built from the discriminators */
  pattern: unknown;
  /**
   * A slice by binding ($this with no fixed value): an item is in it when
   * its code (or one of its codings) is in this value set
   */
  valueSet?: string;
  /** The type its items are checked with: a profiled type, when constrained */
  itemType?: string;
}

/**
 * The values a type is created from: its elements, all optional, without
 * resourceType (the class sets it)
 */
export type FhirInit<T> = {
  -readonly [K in keyof T as K extends 'resourceType' ? never : K]?: T[K];
};
