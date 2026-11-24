import {
  FhirCodecError,
  FhirContext,
  FhirElement,
  FhirExtension,
  FhirProfile,
  FhirSlice,
  getDecimalText,
} from '@fhirjs/core';
import { expect } from 'expect';
import { Patient, r4Model } from '../src/index.js';
import {
  NationalityExtension,
  ReligionExtension,
  TCKN_SYSTEM,
  TrPatient,
} from './_support/tr-patient.js';

const PROFILE_URL = 'http://example.org/fhir/StructureDefinition/tr-patient';
const fhir = new FhirContext(r4Model, {
  types: [TrPatient, ReligionExtension, NationalityExtension],
});

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof FhirCodecError)
      return e.issues.map(i => `${i.code} ${i.expression}: ${i.diagnostics}`);
    throw e;
  }
  throw new Error('Expected a FhirCodecError');
}

const wire = () => ({
  resourceType: 'Patient',
  meta: { profile: [PROFILE_URL] },
  extension: [
    {
      url: 'http://example.org/fhir/StructureDefinition/religion',
      valueCodeableConcept: {
        coding: [{ system: 'http://x/religion', code: 'M' }],
      },
    },
    {
      url: 'http://example.org/fhir/StructureDefinition/nationality',
      extension: [
        { url: 'code', valueCodeableConcept: { coding: [{ code: 'TR' }] } },
      ],
    },
    { url: 'http://other.org/kept', valueString: 'not claimed' },
  ] as any[],
  identifier: [
    { system: 'http://hospital/mrn', value: 'MRN-1' },
    { system: TCKN_SYSTEM, value: '10000000146' },
  ],
  name: [{ family: 'Yılmaz', given: ['Ayşe'] }],
  birthDate: '1990-01-01',
});

describe('Profiles and extensions', () => {
  describe('decode', () => {
    it('picks the registered profile class from meta.profile', () => {
      expect(fhir.decode(wire())).toBeInstanceOf(TrPatient);
      expect(
        fhir.decode(wire(), undefined, { profiles: false }),
      ).not.toBeInstanceOf(TrPatient);
    });

    it('reads JSON as a plain Patient where the profile is not registered', () => {
      const p = new FhirContext(r4Model).decode(wire());
      expect(p).toBeInstanceOf(Patient);
      expect(p).not.toBeInstanceOf(TrPatient);
      expect(p.extension).toHaveLength(3);
    });

    it('moves the slice and the extensions to their properties', () => {
      const p = fhir.decode<TrPatient>(wire());
      expect(p.tckn.value).toBe('10000000146');
      expect(p.identifier.map(i => i.value)).toEqual(['MRN-1']);
      expect(p.religion?.coding?.[0].code).toBe('M');
      expect(p.nationality?.[0]).toBeInstanceOf(NationalityExtension);
      expect(p.nationality?.[0].code.coding?.[0].code).toBe('TR');
      expect(p.extension?.map(e => e.url)).toEqual(['http://other.org/kept']);
    });

    it('checks the parts of a complex extension', () => {
      const bad = wire();
      bad.extension[1].extension = [
        { url: 'period', valuePeriod: { start: '2020' } },
      ];
      expect(issuesOf(() => fhir.decode(bad))).toEqual([
        'required Patient.extension[1].extension: code (code) is required',
      ]);
    });

    it('takes only the value type of a simple extension', () => {
      const bad = wire();
      bad.extension[0] = {
        url: 'http://example.org/fhir/StructureDefinition/religion',
        valueString: 'M',
      };
      expect(issuesOf(() => fhir.decode(bad))).toEqual([
        'structure Patient.extension[0].valueString: ReligionExtension has no element "valueString"',
        'required Patient.extension[0].value[x]: value[x] is required',
      ]);
    });

    it('keeps the precision of a decimal extension', () => {
      const json = wire();
      json.extension.push({
        url: 'http://example.org/fhir/StructureDefinition/birth-weight',
        valueDecimal: 0,
      });
      const p = fhir.decode<TrPatient>(
        JSON.stringify(json).replace('"valueDecimal":0', '"valueDecimal":3.50'),
      );
      expect(p.birthWeight).toBe(3.5);
      expect(getDecimalText(p, 'birthWeight')).toBe('3.50');
      expect(fhir.stringify(p)).toContain('"valueDecimal":3.50');
    });
  });

  describe('encode', () => {
    it('writes the properties back; a round trip keeps every entry', () => {
      const out = fhir.encode(fhir.decode(wire()));
      const byUrl = (a: any[]) =>
        [...a].sort((x, y) => x.url.localeCompare(y.url));
      const byValue = (a: any[]) =>
        [...a].sort((x, y) => x.value.localeCompare(y.value));
      expect(byUrl(out.extension)).toEqual(byUrl(wire().extension));
      expect(byValue(out.identifier)).toEqual(byValue(wire().identifier));
      expect(out.meta).toEqual({ profile: [PROFILE_URL] });
    });

    it('fills in the slice pattern and meta.profile for a TrPatient built in code', () => {
      const out = fhir.encode(
        new TrPatient({
          tckn: { value: '10000000146' },
          birthDate: '1990-01-01',
          religion: { text: 'Islam' },
          nationality: [new NationalityExtension({ code: { text: 'TR' } })],
        }),
      );
      expect(out).toEqual({
        resourceType: 'Patient',
        meta: { profile: [PROFILE_URL] },
        extension: [
          {
            url: 'http://example.org/fhir/StructureDefinition/religion',
            valueCodeableConcept: { text: 'Islam' },
          },
          {
            url: 'http://example.org/fhir/StructureDefinition/nationality',
            extension: [{ url: 'code', valueCodeableConcept: { text: 'TR' } }],
          },
        ],
        identifier: [{ system: TCKN_SYSTEM, value: '10000000146' }],
        birthDate: '1990-01-01',
      });
    });

    it('fails on what the profile requires', () => {
      expect(
        issuesOf(() =>
          fhir.encode(new TrPatient({ identifier: [{ value: 'x' }] })),
        ),
      ).toEqual([
        'required TrPatient.tckn: tckn (tckn) is required',
        'required TrPatient.birthDate: birthDate is required',
      ]);
    });
  });

  describe('profile rules', () => {
    it('refuses a profile that loosens an element', () => {
      @FhirProfile({ url: 'http://x/loose' })
      class Loose extends Patient {
        @FhirElement({ max: '*' })
        declare gender?: any;
      }
      expect(() => r4Model.extend([Loose]).getType(Loose)).toThrow(
        /max Infinity is above the base's 1/,
      );
    });

    it('refuses a profile that adds an element', () => {
      @FhirProfile({ url: 'http://x/added' })
      class Added extends Patient {
        @FhirElement({ type: 'string' })
        declare nickname?: string;
      }
      expect(() => r4Model.extend([Added]).getType(Added)).toThrow(
        /cannot add elements/,
      );
    });

    it('refuses a weaker binding and a type the base does not have', () => {
      @FhirProfile({ url: 'http://x/weak' })
      class Weak extends Patient {
        @FhirElement({
          binding: { strength: 'example', valueSet: 'http://x/vs' },
        })
        declare gender?: any;
      }
      @FhirProfile({ url: 'http://x/type' })
      class WrongType extends Patient {
        @FhirElement({ type: 'integer' })
        declare deceasedBoolean?: any;
      }
      expect(() => r4Model.extend([Weak]).getType(Weak)).toThrow(
        /binding example is weaker than the base's required/,
      );
      expect(() => r4Model.extend([WrongType]).getType(WrongType)).toThrow(
        /type integer is not a type of Patient.deceased\[x\]/,
      );
    });

    it('refuses a slice of an element that does not repeat, and an extension without a url', () => {
      @FhirProfile({ url: 'http://x/slice' })
      class BadSlice extends Patient {
        @FhirSlice({ element: 'gender', name: 'g', pattern: 'male' })
        declare g?: string;
      }
      @FhirProfile({ url: 'http://x/ext' })
      class BadExt extends Patient {
        @FhirExtension({ type: 'string' })
        declare nick?: string;
      }
      expect(() => r4Model.extend([BadSlice]).getType(BadSlice)).toThrow(
        /gender does not repeat/,
      );
      expect(() => r4Model.extend([BadExt]).getType(BadExt)).toThrow(
        /needs a url or a definition/,
      );
    });

    it('does not change the model the context was made from', () => {
      expect(r4Model.findProfile(PROFILE_URL)).toBeUndefined();
      expect(fhir.model.findProfile(PROFILE_URL)?.ctor).toBe(TrPatient);
    });
  });
});
