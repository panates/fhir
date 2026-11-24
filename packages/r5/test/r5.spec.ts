import { FhirCodecError, FhirContext } from '@fhirjs/core';
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
  Observation,
  Patient,
  r5Model,
} from '../src/index.js';

const R5_CORE = packagePath('hl7.fhir.r5.core#5.0.0');
const R5_EXAMPLES = packagePath('hl7.fhir.r5.examples#5.0.0');
const fhir = new FhirContext(r5Model);

describe('R5', () => {
  describe('model', () => {
    it('builds every type from its decorators', () => {
      const names = [...r5Model.typeNames()];
      expect(names.length).toBe(861);
      for (const n of names) expect(r5Model.getType(n).name).toBe(n);
      expect(r5Model.resourceTypes()).toHaveLength(158);
    });

    it('has the R5 base types: Base, DataType, BackboneType', () => {
      expect(r5Model.getType('Patient').isA('Base')).toBe(true);
      expect(r5Model.getType('HumanName').base?.name).toBe('DataType');
      expect(r5Model.getType('Timing').base?.name).toBe('BackboneType');
      expect(
        r5Model.getType('Timing').getElement('modifierExtension'),
      ).toBeDefined();
    });

    it('matches the snapshots of hl7.fhir.r5.core, element by element', function () {
      if (!hasPackage(R5_CORE)) return this.skip();
      // The core package disagrees with itself on X.id: Element says string,
      // the snapshots of the data types say id. The model keeps Element's.
      const known = (path: string, what: string) =>
        what === 'types' && path.endsWith('.id');
      const { checked, errors } = compareWithSnapshots(r5Model, R5_CORE, known);
      expect(errors).toEqual([]);
      expect(checked).toBe(9261);
    });
  });

  describe('codec', () => {
    it('reads integer64 as a JSON string (a number would lose digits)', () => {
      const t = r5Model.getType('integer64');
      expect(t.json).toBe('string');
      const json = {
        resourceType: 'Patient',
        extension: [{ url: 'http://x', valueInteger64: '9007199254740993' }],
      };
      expect(fhir.decode<Patient>(json).extension![0].valueInteger64).toBe(
        '9007199254740993',
      );
      const bad = {
        resourceType: 'Patient',
        extension: [{ url: 'http://x', valueInteger64: 12 }],
      };
      try {
        fhir.decode(bad);
        throw new Error('Expected a FhirCodecError');
      } catch (e) {
        if (!(e instanceof FhirCodecError)) throw e;
        expect(e.issues.map(i => `${i.expression}: ${i.diagnostics}`)).toEqual([
          'Patient.extension[0].valueInteger64: A integer64 must be a JSON string',
        ]);
      }
    });

    it('reads the R5 data types (CodeableReference)', () => {
      const obs = fhir.decode<Observation>({
        resourceType: 'Observation',
        status: 'final',
        code: { text: 'x' },
        triggeredBy: [
          { observation: { reference: 'Observation/1' }, type: 'reflex' },
        ],
        bodyStructure: { reference: 'BodyStructure/1' },
      });
      expect(obs).toBeInstanceOf(Observation);
      expect(r5Model.getType(CodeableReference).name).toBe('CodeableReference');
    });

    it('checks R5 required bindings', () => {
      expect(() =>
        fhir.decode({ resourceType: 'Patient', gender: 'femal' }),
      ).toThrow(
        /"femal" is not in the value set http:\/\/hl7.org\/fhir\/ValueSet\/administrative-gender/,
      );
    });
  });

  describe('examples (hl7.fhir.r5.examples)', function () {
    before(function () {
      if (!hasPackage(R5_EXAMPLES)) this.skip();
    });

    it('decodes and encodes every example back to its source #slow', () => {
      const { ok, failed, differ } = roundTripExamples(fhir, R5_EXAMPLES);
      expect(differ).toEqual([]);
      expect(failed).toEqual({});
      expect(ok).toBe(2822);
    });

    it('keeps the precision of decimals through decode(text) and stringify() #slow', () => {
      const { lost } = decimalPrecision(fhir, R5_EXAMPLES);
      expect(lost).toEqual([]);
    });
  });
});
