import fs from 'node:fs';
import path from 'node:path';
import {
  FhirCodecError,
  FhirContext,
  FhirPackage,
  FhirPackageCache,
} from '@fhirjs/core';
import { expect } from 'expect';
import { Observation, Patient, r4Model } from '../src/index.js';
import { hasPackage, PACKAGE_CACHE, US_CORE } from './_support/packages.js';

/*
 * hl7.fhir.us.core 6.1.0 loaded as data: its profiles and extensions come
 * from the snapshots of its StructureDefinitions, without classes.
 */
describe('Package loading: US Core 6.1.0', function () {
  let fhir: FhirContext;
  const example = (file: string) =>
    JSON.parse(fs.readFileSync(path.join(US_CORE, 'example', file), 'utf8'));
  const issuesOf = (json: unknown): string[] => {
    try {
      fhir.decode(json as object);
    } catch (e) {
      if (e instanceof FhirCodecError)
        return e.issues.map(i => `${i.code} ${i.expression}: ${i.diagnostics}`);
      throw e;
    }
    return [];
  };

  before(function () {
    if (!hasPackage(US_CORE)) return this.skip();
    fhir = new FhirContext(r4Model, {
      packages: [FhirPackage.fromDirectory(US_CORE)],
    });
  });

  it('loads every profile and extension definition', () => {
    const report = fhir.packageReports[0];
    // value sets of US Core's required bindings: 56 listed; 14 include value sets of other
    // packages (VSAC: birthsex, race, ethnicity), filters or code systems not at hand (UCUM)
    expect(report).toMatchObject({
      package: 'hl7.fhir.us.core#6.1.0',
      profiles: 49,
      extensions: 10,
      valueSets: 56,
    });
    expect(report.valueSetsNotListed).toHaveLength(14);
    expect(report.valueSetsNotListed).toContain(
      'http://hl7.org/fhir/us/core/ValueSet/birthsex',
    );
    // slicing by a value set whose codes are not known: counted as not checked
    expect(report.warnings).toHaveLength(3);
    for (const w of report.warnings)
      expect(w).toMatch(/whose codes are not known: slicing not checked$/);
  });

  it('does not change the model the context was made from', () => {
    expect(
      r4Model.findProfile(
        'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient',
      ),
    ).toBeUndefined();
  });

  it('decodes every example of the package against the profiles it names', () => {
    const failed: Record<string, string[]> = {};
    let checked = 0;
    for (const file of fs.readdirSync(path.join(US_CORE, 'example'))) {
      if (!file.endsWith('.json')) continue;
      const json = example(file);
      if (json.meta?.profile?.some((u: string) => fhir.model.findProfile(u)))
        checked++;
      const issues = issuesOf(json);
      if (issues.length) failed[file] = issues;
    }
    expect(failed).toEqual({});
    expect(checked).toBe(174);
  });

  it('gives instances of the generated classes', () => {
    expect(fhir.decode(example('Patient-example.json'))).toBeInstanceOf(
      Patient,
    );
    expect(
      fhir.decode(example('Observation-blood-pressure.json')),
    ).toBeInstanceOf(Observation);
  });

  it('checks a constraint on nested content (Patient.identifier.system 1..1)', () => {
    const p = example('Patient-example.json');
    delete p.identifier[0].system;
    expect(issuesOf(p)).toEqual([
      'required Patient.identifier[0].system: system is required',
    ]);
    // without the profile, the same JSON is a valid Patient
    expect(issuesOf({ ...p, meta: undefined })).toEqual([]);
  });

  it('checks the parts of a complex extension (us-core-race needs text)', () => {
    const p = example('Patient-example.json');
    const race = p.extension.find((e: any) => e.url.endsWith('us-core-race'));
    race.extension = race.extension.filter((e: any) => e.url !== 'text');
    expect(issuesOf(p)).toEqual([
      'required Patient.extension[0].extension: Slice text of extension is required',
    ]);
  });

  it('checks slices by pattern (blood pressure components)', () => {
    const o = example('Observation-blood-pressure.json');
    o.component = o.component.filter(
      (c: any) => c.code.coding[0].code !== '8480-6',
    );
    expect(issuesOf(o)).toEqual([
      'required Observation.component: Slice systolic of component is required',
      'structure Observation.component: component has 1 items, at least 2 required',
    ]);
  });

  it('checks the content of a slice (a vital sign quantity needs its UCUM code)', () => {
    const o = example('Observation-blood-pressure.json');
    delete o.component[0].valueQuantity.code;
    expect(issuesOf(o)).toEqual([
      'required Observation.component[0].valueQuantity.code: code is required',
    ]);
  });

  it('checks slices by value set (Condition.category)', () => {
    const file = fs
      .readdirSync(path.join(US_CORE, 'example'))
      .find(f =>
        example(f).meta?.profile?.[0]?.endsWith(
          'us-core-condition-problems-health-concerns',
        ),
      )!;
    const c = example(file);
    c.category = [{ coding: [{ system: 'http://x', code: 'other' }] }];
    expect(issuesOf(c)).toEqual([
      'required Condition.category: Slice us-core of category is required',
    ]);
  });

  it('checks a required binding of the package (CarePlan.text.status)', () => {
    const file = fs
      .readdirSync(path.join(US_CORE, 'example'))
      .find(f => example(f).resourceType === 'CarePlan')!;
    const cp = example(file);
    cp.text.status = 'empty';
    expect(issuesOf(cp)).toEqual([
      'code-invalid CarePlan.text.status: "empty" is not in the value set http://hl7.org/fhir/us/core/ValueSet/us-core-narrative-status',
    ]);
  });

  it("validates every example with US Core's invariants, and finds a broken one (us-core-6)", () => {
    for (const file of fs
      .readdirSync(path.join(US_CORE, 'example'))
      .filter(f => f.endsWith('.json')))
      expect([file, fhir.validate(example(file)).valid]).toEqual([file, true]);
    const p = example('Patient-example.json');
    p.name = [{ use: 'official' }];
    const errors = fhir.validate(p).issues.filter(i => i.severity === 'error');
    expect(
      errors.map(i => `${i.expression} ${i.diagnostics.split(':')[0]}`),
    ).toEqual(['Patient.name[0] us-core-6']);
  });

  it('encodes with a profile by its name, adding meta.profile', () => {
    const p = fhir.decode(example('Patient-example.json'));
    delete p.meta;
    const out = fhir.encode(p, 'USCorePatientProfile');
    expect(out.meta.profile).toEqual([
      'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient',
    ]);
  });
});

/*
 * The same with its dependencies (terminology, VSAC, PHIN VADS, extensions,
 * SDC ...), read through the package cache from support/fhir-packages.
 */
describe('Package loading: US Core 6.1.0 with its dependencies', function () {
  let fhir: FhirContext;
  let resolution: Awaited<ReturnType<FhirPackageCache['resolve']>>;

  before(async function () {
    const cache = new FhirPackageCache({ dir: PACKAGE_CACHE });
    try {
      resolution = await cache.resolve('hl7.fhir.us.core', '6.1.0');
    } catch {
      return this.skip(); // run node support/fetch-packages.mts
    }
    fhir = new FhirContext(r4Model, { packages: resolution.packages });
  });

  it('loads the dependencies first, the core package with them', () => {
    expect(resolution.packages.map(p => p.id)).toEqual([
      'hl7.fhir.r4.core#4.0.1',
      'hl7.terminology.r4#5.0.0',
      'hl7.fhir.uv.extensions.r4#1.0.0',
      'hl7.fhir.uv.bulkdata#2.0.0',
      'hl7.fhir.uv.smart-app-launch#2.1.0',
      'us.nlm.vsac#0.11.0',
      'hl7.fhir.uv.sdc#3.0.0',
      'us.cdc.phinvads#0.12.0',
      'ihe.formatcode.fhir#1.1.0',
      'hl7.fhir.us.core#6.1.0',
    ]);
    expect(resolution.skipped).toEqual(['hl7.fhir.r4.examples#4.0.1']);
    expect(resolution.conflicts).toEqual([]);
  });

  it("lists more of US Core's value sets with the code systems and value sets of the others", () => {
    const us = fhir.packageReports.at(-1)!;
    expect(us).toMatchObject({ profiles: 49, extensions: 10, valueSets: 68 });
    expect(us.valueSetsNotListed).toHaveLength(2);
    expect(us.valueSetsNotListed).not.toContain(
      'http://hl7.org/fhir/us/core/ValueSet/birthsex',
    );
    // with the core package's value sets, every slicing by value set is checked
    expect(us.warnings).toEqual([]);
    // the core package's own: two examples without a snapshot, a resolve() discriminator
    // The R4 extensions package has a search parameter on R5's DeviceUsage
    for (const r of fhir.packageReports.slice(1, -1))
      expect(r.warnings).toEqual(
        r.package === 'hl7.fhir.uv.extensions.r4#1.0.0'
          ? [
              'http://hl7.org/fhir/SearchParameter/workflow-researchStudy: unknown base DeviceUsage, not loaded',
            ]
          : [],
      );
  });

  it('decodes every example of US Core', () => {
    const dir = path.join(US_CORE, 'example');
    const failed: string[] = [];
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      try {
        fhir.decode(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
      } catch (e) {
        if (!(e instanceof FhirCodecError)) throw e;
        failed.push(`${file}: ${e.message}`);
      }
    }
    expect(failed).toEqual([]);
  });

  it('reads only the value sets and code systems bindings use', () => {
    const vsac = resolution.packages.find(p => p.name === 'us.nlm.vsac')!;
    expect(vsac.entriesOf('ValueSet').length).toBe(14323);
    expect(vsac.parsedCount).toBeLessThan(20);
  });

  it('checks a binding to a VSAC value set (us-core-birthsex)', () => {
    const p = JSON.parse(
      fs.readFileSync(
        path.join(US_CORE, 'example', 'Patient-example.json'),
        'utf8',
      ),
    );
    p.extension.find((e: any) => e.url.endsWith('us-core-birthsex')).valueCode =
      'X';
    try {
      fhir.decode(p);
      throw new Error('Expected a FhirCodecError');
    } catch (e) {
      if (!(e instanceof FhirCodecError)) throw e;
      expect(e.issues.map(i => `${i.expression}: ${i.diagnostics}`)).toEqual([
        'Patient.extension[3].valueCode: "X" is not in the value set http://hl7.org/fhir/us/core/ValueSet/birthsex',
      ]);
    }
  });
});
