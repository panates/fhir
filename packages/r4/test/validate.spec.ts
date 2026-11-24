import fs from 'node:fs';
import path from 'node:path';
import { FhirContext } from '@fhirjs/core';
import { expect } from 'expect';
import {
  hasPackage,
  packagePath,
} from '../../core/test/_support/conformance.js';
import { Patient, r4Model } from '../src/index.js';

const R4_EXAMPLES = packagePath('hl7.fhir.r4.examples#4.0.1');
const fhir = new FhirContext(r4Model);
const NARRATIVE = {
  status: 'generated',
  div: '<div xmlns="http://www.w3.org/1999/xhtml">x</div>',
};
const errors = (r: ReturnType<FhirContext['validate']>) =>
  r.issues
    .filter(i => i.severity === 'error')
    .map(i => `${i.code} ${i.expression}: ${i.diagnostics}`);

describe('validate()', () => {
  it('passes a valid resource', () => {
    const r = fhir.validate({
      resourceType: 'Patient',
      text: NARRATIVE,
      gender: 'female',
    });
    expect(r).toMatchObject({ valid: true, issues: [] });
    expect(r.value).toBeInstanceOf(Patient);
  });

  it('runs the invariants of a resource, its backbone elements and its data types', () => {
    const r = fhir.validate({
      resourceType: 'Patient',
      text: NARRATIVE,
      contact: [{ relationship: [{ text: 'x' }] }],
      extension: [
        {
          url: 'http://x',
          valueString: 'a',
          extension: [{ url: 'b', valueString: 'c' }],
        },
      ],
    });
    expect(r.valid).toBe(false);
    expect(errors(r)).toEqual([
      'invariant Patient.extension[0]: ext-1: Must have either extensions or value[x], not both',
      "invariant Patient.contact[0]: pat-1: SHALL at least contain a contact's details or a reference to an organization",
    ]);
  });

  it("reports the codec's issues and the invariants together, without throwing", () => {
    const r = fhir.validate({
      resourceType: 'Patient',
      text: NARRATIVE,
      gender: 'femal',
      contained: [{ resourceType: 'Organization', id: 'o1' }],
    });
    expect(errors(r)).toEqual([
      'code-invalid Patient.gender: "femal" is not in the value set http://hl7.org/fhir/ValueSet/administrative-gender',
      'invariant Patient: dom-3: If the resource is contained in another resource, it SHALL be referred to from elsewhere in the resource or SHALL refer to the containing resource',
      'invariant Patient.contained[0]: org-1: The organization SHALL at least have a name or an identifier, and possibly more than one',
    ]);
    expect(r.value).toBeUndefined();
  });

  it('gives warnings (dom-6), not for a contained resource, and leaves them out on request', () => {
    const p = {
      resourceType: 'Patient',
      contained: [{ resourceType: 'Organization', id: 'o1', name: 'x' }],
      managingOrganization: { reference: '#o1' },
    };
    expect(
      fhir
        .validate(p)
        .issues.map(
          i => `${i.severity} ${i.expression} ${i.diagnostics.split(':')[0]}`,
        ),
    ).toEqual(['warning Patient dom-6']);
    expect(fhir.validate(p, undefined, { warnings: false }).issues).toEqual([]);
  });

  it('checks an instance built in code', () => {
    expect(
      fhir.validate(new Patient({ text: NARRATIVE as any, gender: 'male' }))
        .valid,
    ).toBe(true);
    expect(
      errors(
        fhir.validate(
          new Patient({
            text: NARRATIVE as any,
            contact: [{ gender: 'male' }],
          }),
        ),
      ),
    ).toEqual([
      "invariant Patient.contact[0]: pat-1: SHALL at least contain a contact's details or a reference to an organization",
    ]);
  });

  it('gives an OperationOutcome', () => {
    expect(
      fhir.validate({ resourceType: 'Patient', text: NARRATIVE }).outcome(),
    ).toEqual({
      resourceType: 'OperationOutcome',
      issue: [
        {
          severity: 'information',
          code: 'informational',
          diagnostics: 'No issues',
        },
      ],
    });
    expect(
      fhir
        .validate({ resourceType: 'Patient', text: NARRATIVE, gender: 'x' })
        .outcome().issue,
    ).toEqual([
      {
        severity: 'error',
        code: 'code-invalid',
        diagnostics:
          '"x" is not in the value set http://hl7.org/fhir/ValueSet/administrative-gender',
        expression: ['Patient.gender'],
      },
    ]);
  });

  it("answers memberOf() from the model's value sets", () => {
    const fp = fhir.invariants.fhirPath;
    const vs = 'http://hl7.org/fhir/ValueSet/administrative-gender';
    expect(
      fp.evaluate(
        { resourceType: 'Patient', gender: 'male' },
        `gender.memberOf('${vs}')`,
      ),
    ).toEqual([true]);
    expect(
      fp.evaluate(
        { resourceType: 'Patient', gender: 'x' },
        `gender.memberOf('${vs}')`,
      ),
    ).toEqual([false]);
    expect(
      fp.evaluate(
        { resourceType: 'Patient', gender: 'x' },
        "gender.memberOf('http://unknown')",
      ),
    ).toEqual([]);
  });

  it("finds every invalid R4 example: the codec's 13 and the invariants' 8 #slow", function () {
    if (!hasPackage(R4_EXAMPLES)) return this.skip();
    this.timeout(120000);
    const invalid: Record<string, string[]> = {};
    for (const file of fs.readdirSync(R4_EXAMPLES)) {
      if (
        !file.endsWith('.json') ||
        file === 'package.json' ||
        file.startsWith('.')
      )
        continue;
      const r = fhir.validate(
        JSON.parse(fs.readFileSync(path.join(R4_EXAMPLES, file), 'utf8')),
      );
      if (!r.valid)
        invalid[file] = [
          ...new Set(
            r.issues
              .filter(i => i.severity === 'error')
              .map(i =>
                i.code === 'invariant' ? i.diagnostics.split(':')[0] : i.code,
              ),
          ),
        ];
    }
    const byReason: Record<string, number> = {};
    for (const reasons of Object.values(invalid))
      for (const r of reasons) byReason[r] = (byReason[r] || 0) + 1;
    expect(Object.keys(invalid)).toHaveLength(21);
    // required: the 13 the codec finds (missing linkId, base, name, status)
    expect(byReason).toEqual({
      required: 13,
      'sdf-4': 4,
      'sdf-19': 3,
      'bdl-7': 1,
    });
  });
});
