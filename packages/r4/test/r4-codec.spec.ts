import { expect } from 'expect';
import { FhirCodecError, FhirContext, getDecimalText } from '@fhirjs/core';
import { vg } from 'valgen';
import {
  Element,
  Extension,
  HumanName,
  Observation,
  Organization,
  Patient,
  r4Model,
} from '../src/index.js';

const fhir = new FhirContext(r4Model);

/** The issues of a failing call, as 'code expression: diagnostics' */
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

describe('R4 codec', () => {
  describe('decode', () => {
    const json = {
      resourceType: 'Patient',
      birthDate: '1985-04-12',
      _birthDate: {
        extension: [
          {
            url: 'http://x/birthTime',
            valueDateTime: '1985-04-12T10:00:00+03:00',
          },
        ],
      },
      name: [
        {
          family: 'Yılmaz',
          given: ['Ayşe', null],
          _given: [
            null,
            { extension: [{ url: 'http://x/a', valueString: 'b' }] },
          ],
        },
      ],
      gender: 'female',
      contained: [{ resourceType: 'Organization', id: 'o1', name: 'Hastane' }],
    };

    it('creates the generated classes at every level', () => {
      const p = fhir.decode(json);
      expect(p).toBeInstanceOf(Patient);
      expect(p.name[0]).toBeInstanceOf(HumanName);
      expect(p.contained[0]).toBeInstanceOf(Organization);
      expect(p._birthDate).toBeInstanceOf(Element);
      expect(p._birthDate.extension[0]).toBeInstanceOf(Extension);
    });

    it('takes JSON text, and a class to expect', () => {
      expect(fhir.decode(JSON.stringify(json), Patient).gender).toBe('female');
      expect(issuesOf(() => fhir.decode(json, Observation))).toEqual([
        'structure Observation.resourceType: resourceType must be "Observation", not "Patient"',
      ]);
    });

    it('gives plain objects with plain: true', () => {
      const p = fhir.decode(json, undefined, { plain: true });
      expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(p.name[0])).toBe(Object.prototype);
    });

    it('reports every structural problem with its place', () => {
      const bad = {
        resourceType: 'Patient',
        gender: 'female',
        birthDate: '12.04.1985',
        deceasedBoolean: false,
        deceasedDateTime: '2020',
        name: [],
        foo: 1,
        contact: [{ name: { family: '' } }],
        link: [{ type: 'seealso' }],
        contained: [{ resourceType: 'Nope' }],
      };
      expect(issuesOf(() => fhir.decode(bad))).toEqual([
        'structure Patient.deceasedDateTime: Only one of deceasedBoolean, deceasedDateTime may be present (deceased[x])',
        'structure Patient.foo: Patient has no element "foo"',
        'value Patient.birthDate: "12.04.1985" is not a valid date',
        'structure Patient.name: An array must not be empty',
        'value Patient.contact[0].name.family: A string must not be empty',
        'required Patient.link[0].other: other is required',
        'not-supported Patient.contained[0]: Unknown resource type "Nope"',
      ]);
    });

    it('pairs a primitive array with its _x array', () => {
      const name = (given: unknown, _given: unknown) => ({
        resourceType: 'Patient',
        name: [{ given, _given }],
      });
      expect(issuesOf(() => fhir.decode(name(['a'], [null, null])))).toEqual([
        'structure Patient.name[0]._given: _given must have as many items as given (2 != 1)',
      ]);
      expect(
        issuesOf(() => fhir.decode(name(['a', null], [null, null]))),
      ).toEqual([
        'structure Patient.name[0].given[1]: An item must have a value or extensions',
      ]);
    });

    it('counts _x alone as presence of a required element', () => {
      const obs = {
        resourceType: 'Observation',
        _status: {
          extension: [{ url: 'http://x/absent', valueCode: 'unknown' }],
        },
        code: { text: 'x' },
      };
      expect(fhir.decode(obs)).toBeInstanceOf(Observation);
      expect(
        issuesOf(() =>
          fhir.decode({ resourceType: 'Observation', code: { text: 'x' } }),
        ),
      ).toEqual(['required Observation.status: status is required']);
    });

    it('keeps or drops unknown elements when asked', () => {
      const withFoo = { resourceType: 'Patient', gender: 'male', foo: 1 };
      expect(
        fhir.decode(withFoo, undefined, { unknownElements: 'keep' }).foo,
      ).toBe(1);
      expect(
        fhir.decode(withFoo, undefined, { unknownElements: 'drop' }).foo,
      ).toBeUndefined();
    });

    it('skips required elements with partial: true', () => {
      const obs = { resourceType: 'Observation', code: { text: 'x' } };
      expect(fhir.decode(obs, undefined, { partial: true })).toBeInstanceOf(
        Observation,
      );
    });
  });

  describe('encode', () => {
    it('writes resourceType first and keys in definition order', () => {
      const out = fhir.encode(
        new Observation({
          valueQuantity: { value: 1.5 },
          code: { text: 'x' },
          status: 'final',
        }),
      );
      expect(Object.keys(out)).toEqual([
        'resourceType',
        'status',
        'code',
        'valueQuantity',
      ]);
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    });

    it('takes a Date for date, dateTime and instant', () => {
      const out = fhir.encode(
        new Observation({
          status: 'final',
          code: { text: 'x' },
          effectiveDateTime: new Date(Date.UTC(2026, 10, 20, 9, 30)) as any,
        }),
      );
      expect(out.effectiveDateTime).toBe('2026-11-20T09:30:00.000Z');
    });

    it('takes plain objects and fills in resourceType', () => {
      expect(fhir.encode({ gender: 'male' }, Patient)).toEqual({
        resourceType: 'Patient',
        gender: 'male',
      });
    });
  });

  describe('required bindings', () => {
    it('checks codes on decode and on encode', () => {
      expect(
        issuesOf(() =>
          fhir.decode({ resourceType: 'Patient', gender: 'femal' }),
        ),
      ).toEqual([
        'code-invalid Patient.gender: "femal" is not in the value set http://hl7.org/fhir/ValueSet/administrative-gender',
      ]);
      expect(
        issuesOf(() => fhir.encode(new Patient({ gender: 'x' as any }))),
      ).toEqual([
        'code-invalid Patient.gender: "x" is not in the value set http://hl7.org/fhir/ValueSet/administrative-gender',
      ]);
    });

    it('checks a CodeableConcept: one coding must be in the value set', () => {
      const ae = (severity: unknown) => ({
        resourceType: 'AdverseEvent',
        actuality: 'actual',
        subject: { reference: 'Patient/1' },
        severity,
      });
      const system =
        'http://terminology.hl7.org/CodeSystem/adverse-event-severity';
      expect(
        fhir.decode(
          ae({
            coding: [
              { system: 'http://x', code: 'a' },
              { system, code: 'mild' },
            ],
          }),
        ),
      ).toBeTruthy();
      expect(
        issuesOf(() => fhir.decode(ae({ coding: [{ system, code: 'bad' }] }))),
      ).toEqual([
        `code-invalid AdverseEvent.severity: None of the codings (${system}#bad) is in the value set http://hl7.org/fhir/ValueSet/adverse-event-severity`,
      ]);
      expect(issuesOf(() => fhir.decode(ae({ text: 'mild' })))).toEqual([
        'code-invalid AdverseEvent.severity: A coding from the value set http://hl7.org/fhir/ValueSet/adverse-event-severity is required',
      ]);
    });

    it('can be turned off', () => {
      expect(
        fhir.decode({ resourceType: 'Patient', gender: 'femal' }, undefined, {
          bindings: false,
        }).gender,
      ).toBe('femal');
    });
  });

  describe('decimal precision', () => {
    const text =
      '{"resourceType":"Observation","status":"final","code":{"text":"Hb"},' +
      '"valueQuantity":{"value":11.20,"unit":"g/dL"},' +
      '"referenceRange":[{"low":{"value":12.0},"high":{"value":1.5E1}}]}';

    it('keeps the written text through decode(text) and stringify()', () => {
      const o = fhir.decode<Observation>(text);
      expect(o.valueQuantity!.value).toBe(11.2);
      expect(getDecimalText(o.valueQuantity!, 'value')).toBe('11.20');
      expect(fhir.stringify(o)).toBe(text);
    });

    it('writes a value changed in code as its number', () => {
      const o = fhir.decode<Observation>(text);
      o.valueQuantity!.value = 11.3;
      expect(fhir.stringify(o)).toContain('"value":11.3,');
    });

    it('keeps numbers only with decimals: "number"', () => {
      expect(
        fhir.stringify(fhir.decode(text, undefined, { decimals: 'number' })),
      ).toContain('"value":11.2,');
    });
  });

  it('is a valgen validator: works inside an opra-style schema', () => {
    const body = vg.isObject({
      patient: vg.required(fhir.codecs('decode').toValidator('Patient')),
    });
    expect(
      (body({ patient: { resourceType: 'Patient', gender: 'male' } }) as any)
        .patient,
    ).toBeInstanceOf(Patient);
    const errors = body.silent({
      patient: { resourceType: 'Patient', birthDate: 'x' },
    }).errors!;
    expect(errors.map(e => [e.location, e.message, e.fhirCode])).toEqual([
      ['patient.birthDate', '"x" is not a valid date', 'value'],
    ]);
  });
});
