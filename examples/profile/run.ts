/*
 * Reads a Turkish patient with the TrPatient profile and writes one built in
 * code. The checks of this behaviour are in packages/r4/test/profile.spec.ts.
 */
import { FhirCodecError, FhirContext } from '@fhirjs/core';
import { r4Model } from '@fhirjs/r4';
import {
  NationalityExtension,
  ReligionExtension,
  TrPatient,
} from './tr-patient.js';

const fhir = new FhirContext(r4Model, {
  types: [TrPatient, ReligionExtension, NationalityExtension],
});

// Reading: meta.profile names TrPatient, so the result is one
const p = fhir.decode<TrPatient>(`{
  "resourceType": "Patient",
  "meta": { "profile": ["http://example.org/fhir/StructureDefinition/tr-patient"] },
  "extension": [
    { "url": "http://example.org/fhir/StructureDefinition/religion",
      "valueCodeableConcept": { "text": "Islam" } },
    { "url": "http://example.org/fhir/StructureDefinition/birth-weight", "valueDecimal": 3.50 }
  ],
  "identifier": [{ "system": "urn:oid:2.16.840.1.113883.3.9900.1", "value": "10000000146" }],
  "name": [{ "family": "Yılmaz", "given": ["Ayşe"] }],
  "birthDate": "1990-01-01"
}`);
console.log(
  p instanceof TrPatient,
  p.tckn.value,
  p.religion?.text,
  p.birthWeight,
);

// Writing: the slice gets its system, the extensions their entries
const q = new TrPatient({
  tckn: { value: '10000000146' },
  birthDate: '1990-01-01',
  nationality: [new NationalityExtension({ code: { text: 'TR' } })],
});
console.log(fhir.stringify(q, { space: 2 }));

// Failing: what the profile requires is missing
try {
  fhir.encode(new TrPatient({ name: [{ family: 'Kaya' }] }));
} catch (e) {
  if (!(e instanceof FhirCodecError)) throw e;
  for (const i of e.issues)
    console.log(`${i.code} ${i.expression}: ${i.diagnostics}`);
}
