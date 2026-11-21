import fs from 'node:fs';
import path from 'node:path';
import { expect } from 'expect';
import { FhirCodecError, FhirContext, FhirPackage } from '@fhirjs/core';
import {
  hasPackage,
  packagePath,
} from '../../core/test/_support/conformance.js';
import { r4Model } from '../src/index.js';

const R4_CORE = packagePath('hl7.fhir.r4.core#4.0.1');
const R4_EXAMPLES = packagePath('hl7.fhir.r4.examples#4.0.1');
const SD = 'http://hl7.org/fhir/StructureDefinition/';

/*
 * The core package loaded as data on top of the generated model: its
 * profiles (vitalsigns, bp ...), extension definitions (patient-birthPlace
 * ...) and value sets.
 */
describe('The R4 core package as data', function () {
  let fhir: FhirContext;
  let pkg: FhirPackage;
  const issuesOf = (json: unknown, options?: object): string[] => {
    try {
      fhir.decode(json as object, undefined, options);
    } catch (e) {
      if (e instanceof FhirCodecError)
        return e.issues.map(i => `${i.code} ${i.expression}: ${i.diagnostics}`);
      throw e;
    }
    return [];
  };
  const example = (file: string) =>
    JSON.parse(fs.readFileSync(path.join(R4_EXAMPLES, file), 'utf8'));

  before(function () {
    if (!hasPackage(R4_CORE)) return this.skip();
    pkg = FhirPackage.fromDirectory(R4_CORE);
    fhir = new FhirContext(r4Model, { packages: [pkg] });
  });

  it('loads its profiles and extension definitions, not the types the model has', () => {
    const report = fhir.packageReports[0];
    expect(report).toMatchObject({ profiles: 46, extensions: 396 });
    expect(report.warnings).toEqual([
      `${SD}example-composition: no snapshot, not loaded`,
      `${SD}example-section-library: no snapshot, not loaded`,
      `${SD}lipidprofile: DiagnosticReport.result:Cholesterol has no value for discriminator resolve().code: slicing not checked`,
    ]);
    // the 653 StructureDefinitions of the generated types are not read
    expect(pkg.parsedCount).toBeLessThan(600);
    expect(fhir.model.findProfile(`${SD}vitalsigns`)?.kind).toBe('profile');
    expect(fhir.model.findProfile(`${SD}patient-birthPlace`)?.kind).toBe(
      'extension',
    );
  });

  it('decodes every valid example against the core profiles and extensions it uses', function () {
    if (!hasPackage(R4_EXAMPLES)) return this.skip();
    let ok = 0;
    let checked = 0;
    const failed: string[] = [];
    for (const file of fs.readdirSync(R4_EXAMPLES)) {
      if (
        !file.endsWith('.json') ||
        file === 'package.json' ||
        file.startsWith('.')
      )
        continue;
      const json = example(file);
      if (json.meta?.profile?.some((u: string) => fhir.model.findProfile(u)))
        checked++;
      if (issuesOf(json).length) failed.push(file);
      else ok++;
    }
    // the same 13 as without the core package (missing required elements)
    expect([ok, failed.length, checked]).toEqual([5296, 13, 1943]);
  });

  it('checks a vital sign against vitalsigns and bp', function () {
    if (!hasPackage(R4_EXAMPLES)) return this.skip();
    const bp = example('Observation-blood-pressure.json');
    bp.category = [{ text: 'x' }];
    expect(issuesOf(bp)).toEqual([
      'required Observation.category: Slice VSCat of category is required',
    ]);

    const asBp = example('Observation-blood-pressure.json');
    asBp.meta = { profile: [`${SD}bp`] };
    expect(issuesOf(asBp)).toEqual([]);
    asBp.component = asBp.component.slice(1);
    expect(issuesOf(asBp)).toEqual([
      'required Observation.component: Slice SystolicBP of component is required',
      'structure Observation.component: component has 1 items, at least 2 required',
    ]);
  });

  it('checks an extension against its definition, without a profile on the resource', () => {
    const p = {
      resourceType: 'Patient',
      extension: [{ url: `${SD}patient-birthPlace`, valueString: 'Ankara' }],
    };
    expect(issuesOf(p)).toEqual([
      'structure Patient.extension[0].valueString: birthPlace has no element "valueString"',
      'required Patient.extension[0].value[x]: value[x] is required',
    ]);
    expect(issuesOf(p, { extensions: false })).toEqual([]);
    const ok = {
      resourceType: 'Patient',
      extension: [
        { url: `${SD}patient-birthPlace`, valueAddress: { city: 'Ankara' } },
      ],
    };
    expect(issuesOf(ok)).toEqual([]);
  });
});
