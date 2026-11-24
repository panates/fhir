import { FhirContext, FhirPackage, FhirProfile } from '@fhirjs/core';
import { expect } from 'expect';
import { describeSearchParameters } from '../../core/test/_support/search-parameters.js';
import { Patient, R4_SEARCH_PARAMETERS, r4Model } from '../src/index.js';
import { hasPackage, R4_CORE, US_CORE } from './_support/packages.js';

/** SearchParameter resources of US Core 6.1.0 */
const US_CORE_SEARCH_PARAMETERS = 106;

// Patient.age and Patient.birthOrderBoolean come without an expression in the core package
describeSearchParameters('R4', r4Model, R4_SEARCH_PARAMETERS, 1387, [
  'DomainResource._text',
  'Patient.age',
  'Patient.birthOrderBoolean',
  'Resource._content',
  'Resource._filter',
  'Resource._query',
]);

describe('Search parameters of R4: profiles and packages', function () {
  @FhirProfile({
    url: 'http://example.org/fhir/StructureDefinition/sp-patient',
  })
  class SpPatient extends Patient {}

  it("gives a profile its type's parameters, and keeps them in a context's model", () => {
    const fhir = new FhirContext(r4Model, { types: [SpPatient] });
    expect(fhir.model).not.toBe(r4Model);
    expect(fhir.model.getSearchParameter('SpPatient', 'birthdate')?.url).toBe(
      'http://hl7.org/fhir/SearchParameter/individual-birthdate',
    );
    expect(fhir.model.searchParameters('Patient').size).toBe(
      r4Model.searchParameters('Patient').size,
    );
  });

  it("adds an implementation guide's parameters, and none of the core package's", function () {
    if (!hasPackage(US_CORE) || !hasPackage(R4_CORE)) return this.skip();
    const fhir = new FhirContext(r4Model, {
      packages: [
        FhirPackage.fromDirectory(R4_CORE),
        FhirPackage.fromDirectory(US_CORE),
      ],
    });
    const [core, us] = fhir.packageReports;
    expect(core.searchParameters).toBe(0);
    expect(us.searchParameters).toBe(US_CORE_SEARCH_PARAMETERS);
    expect(fhir.model.getSearchParameter('Patient', 'race')).toMatchObject({
      url: 'http://hl7.org/fhir/us/core/SearchParameter/us-core-race',
      type: 'token',
    });
    // US Core's own _id of Patient replaces Resource's there; the core package's example of
    // _id replaces nothing
    expect(fhir.model.getSearchParameter('Patient', '_id')?.url).toBe(
      'http://hl7.org/fhir/us/core/SearchParameter/us-core-patient-id',
    );
    expect(fhir.model.getSearchParameter('Account', '_id')?.url).toBe(
      'http://hl7.org/fhir/SearchParameter/Resource-id',
    );
    // the model the context was made from does not change
    expect(r4Model.getSearchParameter('Patient', 'race')).toBeUndefined();
  });
});
