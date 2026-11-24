/** A child element of a type, as a FHIRPath navigation sees it */
export interface FhirPathChild {
  /** The JSON key: 'name', 'valueQuantity', 'birthDate' */
  key: string;
  /** Its type: 'HumanName', 'Quantity', 'date', 'Resource', or a backbone 'Patient.contact' */
  type: string;
}

/**
 * What FHIRPath needs from a FHIR model: the children of a type, its
 * hierarchy, and which types are primitives. @fhirjs/core gives one built on
 * its FhirModel; without a model, navigation follows the JSON keys and type
 * tests know only the System types and resourceType.
 */
export interface FhirPathModel {
  /**
   * The children named `name` of a value of `type`. For a choice ('value'),
   * one entry per JSON key it may have ('valueQuantity', 'valueString' ...).
   * Undefined when the type has no such element.
   */
  getChildren(type: string, name: string): readonly FhirPathChild[] | undefined;
  /** Every child of a type, for children() and descendants() */
  allChildren(type: string): readonly FhirPathChild[];
  /** Whether the model has a type of this name */
  hasType(type: string): boolean;
  /** Whether `type` is `base` or derives from it ('Patient' is a 'DomainResource') */
  isType(type: string, base: string): boolean;
  /** Whether a type is a FHIR primitive ('boolean', 'string', 'date') */
  isPrimitive(type: string): boolean;
  /**
   * Whether a type is abstract (Resource, DomainResource): a value of it is
   * one of its subtypes, so check() does not fail on elements it lacks
   */
  isAbstract?(type: string): boolean;
}

/** The FHIRPath System type a FHIR primitive is read as */
export const SYSTEM_TYPE_OF_PRIMITIVE: Record<string, string> = {
  boolean: 'Boolean',
  string: 'String',
  code: 'String',
  id: 'String',
  uri: 'String',
  url: 'String',
  canonical: 'String',
  oid: 'String',
  uuid: 'String',
  markdown: 'String',
  base64Binary: 'String',
  xhtml: 'String',
  integer: 'Integer',
  unsignedInt: 'Integer',
  positiveInt: 'Integer',
  integer64: 'Integer',
  decimal: 'Decimal',
  date: 'Date',
  dateTime: 'DateTime',
  instant: 'DateTime',
  time: 'Time',
};
