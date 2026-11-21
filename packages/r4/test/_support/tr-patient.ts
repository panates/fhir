/*
 * A profile on Patient with a slice and three kinds of extensions, as a
 * developer of a national profile would write it.
 */
import {
  FhirElement,
  FhirExtension,
  FhirExtensionType,
  type FhirInit,
  FhirProfile,
  FhirSlice,
} from '@fhirjs/core';
import {
  type CodeableConcept,
  Extension,
  type Identifier,
  Patient,
  type Period,
} from '../../src/index.js';

export const TCKN_SYSTEM = 'urn:oid:2.16.840.1.113883.3.9900.1';

/** A simple extension: its value is a CodeableConcept */
@FhirExtensionType({
  url: 'http://example.org/fhir/StructureDefinition/religion',
  context: ['Patient'],
  value: { type: 'CodeableConcept' },
})
export class ReligionExtension extends Extension {}

/** A complex extension: parts instead of a value */
@FhirExtensionType({
  url: 'http://example.org/fhir/StructureDefinition/nationality',
  context: ['Patient'],
})
export class NationalityExtension extends Extension {
  constructor(init?: FhirInit<NationalityExtension>) {
    super(init as FhirInit<Extension>);
  }

  @FhirExtension({ url: 'code', type: 'CodeableConcept', min: 1 })
  declare code: CodeableConcept;

  @FhirExtension({ url: 'period', type: 'Period' })
  declare period?: Period;
}

@FhirProfile({ url: 'http://example.org/fhir/StructureDefinition/tr-patient' })
export class TrPatient extends Patient {
  constructor(init?: FhirInit<TrPatient>) {
    super(init as FhirInit<Patient>);
  }

  /* Inherited elements, tightened: only what changes */
  @FhirElement({ min: 1 })
  declare identifier: Identifier[];

  @FhirElement({ min: 1 })
  declare birthDate: string;

  /* A slice of identifier: the TC identity number */
  @FhirSlice({
    element: 'identifier',
    name: 'tckn',
    min: 1,
    max: 1,
    pattern: { system: TCKN_SYSTEM },
  })
  declare tckn: Identifier;

  /* Extensions, as properties */
  @FhirExtension({ extension: () => ReligionExtension })
  declare religion?: CodeableConcept;

  @FhirExtension({ extension: () => NationalityExtension, max: '*' })
  declare nationality?: NationalityExtension[];

  @FhirExtension({
    url: 'http://example.org/fhir/StructureDefinition/birth-weight',
    type: 'decimal',
  })
  declare birthWeight?: number;
}
