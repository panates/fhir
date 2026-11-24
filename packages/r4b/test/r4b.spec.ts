import { FhirContext } from '@fhirjs/core';
import { expect } from 'expect';
import {
  compareWithSnapshots,
  decimalPrecision,
  hasPackage,
  packagePath,
  roundTripExamples,
} from '../../core/test/_support/conformance.js';
import {
  CodeableReference,
  MedicationRequest,
  r4bModel,
  SubscriptionTopic,
} from '../src/index.js';

const R4B_CORE = packagePath('hl7.fhir.r4b.core#4.3.0');
const R4B_EXAMPLES = packagePath('hl7.fhir.r4b.examples#4.3.0');
const fhir = new FhirContext(r4bModel);

describe('R4B', () => {
  describe('model', () => {
    it('builds every type from its decorators', () => {
      const names = [...r4bModel.typeNames()];
      expect(names.length).toBe(702);
      for (const n of names) expect(r4bModel.getType(n).name).toBe(n);
      expect(r4bModel.resourceTypes()).toHaveLength(141);
    });

    it("keeps R4's base types (Element, BackboneElement), not R5's", () => {
      // R4B has a DataType definition, but its data types still derive from Element
      expect(r4bModel.getType('HumanName').base?.name).toBe('Element');
      expect(r4bModel.getType('Timing').base?.name).toBe('BackboneElement');
    });

    it('matches the snapshots of hl7.fhir.r4b.core, element by element', function () {
      if (!hasPackage(R4B_CORE)) return this.skip();
      // As in R5, the core package disagrees with itself on X.id: Element says
      // string, the snapshots of the backbone elements say id. The model keeps Element's.
      const known = (path: string, what: string) =>
        what === 'types' && path.endsWith('.id');
      const { checked, errors } = compareWithSnapshots(
        r4bModel,
        R4B_CORE,
        known,
      );
      expect(errors).toEqual([]);
      expect(checked).toBe(7519);
    });
  });

  describe('codec', () => {
    it('reads the types R4B took from R5 (CodeableReference, SubscriptionTopic)', () => {
      const topic = fhir.decode<SubscriptionTopic>({
        resourceType: 'SubscriptionTopic',
        url: 'http://example.org/topic',
        status: 'active',
        resourceTrigger: [
          { resource: 'http://hl7.org/fhir/StructureDefinition/Encounter' },
        ],
      });
      expect(topic).toBeInstanceOf(SubscriptionTopic);
      expect(r4bModel.getType(CodeableReference).name).toBe(
        'CodeableReference',
      );
    });

    it('checks R4B required bindings', () => {
      expect(() =>
        fhir.decode<MedicationRequest>({
          resourceType: 'MedicationRequest',
          status: 'activ',
          intent: 'order',
          medicationCodeableConcept: { text: 'x' },
          subject: { reference: 'Patient/1' },
        }),
      ).toThrow(
        /"activ" is not in the value set http:\/\/hl7.org\/fhir\/ValueSet\/medicationrequest-status/,
      );
    });
  });

  describe('examples (hl7.fhir.r4b.examples)', function () {
    before(function () {
      if (!hasPackage(R4B_EXAMPLES)) this.skip();
    });

    it('decodes and encodes every example back to its source #slow', () => {
      const { ok, failed, differ } = roundTripExamples(fhir, R4B_EXAMPLES);
      expect(differ).toEqual([]);
      // Invalid in the package itself: a required status or SearchParameter.base
      // missing, an id over 64 characters
      expect(
        Object.entries(failed).map(
          ([f, m]) => `${f}: ${String(m).replace(/^.*?: /, '')}`,
        ),
      ).toEqual([
        'Bundle-valuesets.json: status is required',
        'CodeSystem-catalogType.json: status is required',
        'SearchParameter-codesystem-extensions-CodeSystem-author.json: base is required',
        'SearchParameter-codesystem-extensions-CodeSystem-effective.json: base is required',
        'SearchParameter-codesystem-extensions-CodeSystem-end.json: base is required',
        'SearchParameter-codesystem-extensions-CodeSystem-keyword.json: base is required',
        'SearchParameter-codesystem-extensions-CodeSystem-workflow.json: base is required',
        'SearchParameter-questionnaireresponse-extensions-QuestionnaireResponse-item-subject.json: "questionnaireresponse-extensions-Questio…" is not a valid id',
        'SearchParameter-valueset-extensions-ValueSet-author.json: base is required',
        'SearchParameter-valueset-extensions-ValueSet-effective.json: base is required',
        'SearchParameter-valueset-extensions-ValueSet-end.json: base is required',
        'SearchParameter-valueset-extensions-ValueSet-keyword.json: base is required',
        'SearchParameter-valueset-extensions-ValueSet-workflow.json: base is required',
        'ValueSet-catalogType.json: status is required',
      ]);
      expect(ok).toBe(2826);
    });

    it('keeps the precision of decimals through decode(text) and stringify() #slow', () => {
      const { lost } = decimalPrecision(fhir, R4B_EXAMPLES);
      expect(lost).toEqual([]);
    });
  });
});
