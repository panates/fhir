import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect } from 'expect';
import {
  type FhirConstraintOptions,
  FhirContext,
  fhirPathModelOf,
  type FhirTypeInfo,
} from '@fhirjs/core';
import { FhirPath } from '@fhirjs/fhirpath';
import {
  hasPackage,
  packagePath,
} from '../../core/test/_support/conformance.js';
import { Patient, r4Model } from '../src/index.js';

const R4_EXAMPLES = packagePath('hl7.fhir.r4.examples#4.0.1');
const fp = new FhirPath({ model: fhirPathModelOf(r4Model) });
/** As the validator runs R4 invariants: lenient typing */
const lenient = new FhirPath({
  model: fhirPathModelOf(r4Model),
  lenient: true,
});
const fhir = new FhirContext(r4Model);

describe('FHIRPath over the R4 model', () => {
  const p = fhir.decode<Patient>({
    resourceType: 'Patient',
    deceasedDateTime: '2020-01-01',
    multipleBirthInteger: 2,
    name: [{ family: 'Yılmaz' }],
    contact: [{ name: { family: 'K' } }],
    contained: [{ resourceType: 'Organization', id: 'o1' }],
  });

  it('navigates a choice by its name and tests its FHIR type', () => {
    expect(fp.evaluate(p, 'deceased')).toEqual(['2020-01-01']);
    expect(fp.evaluate(p, 'deceased is dateTime')).toEqual([true]);
    expect(fp.evaluate(p, 'deceased is boolean')).toEqual([false]);
    expect(fp.evaluate(p, 'deceased.ofType(dateTime) > @2019')).toEqual([true]);
    expect(fp.evaluate(p, 'multipleBirth is integer')).toEqual([true]);
  });

  it('knows the hierarchy: a Patient is a DomainResource; a contained Organization', () => {
    expect(fp.evaluate(p, '$this is DomainResource')).toEqual([true]);
    expect(fp.evaluate(p, 'contained.ofType(Organization).id')).toEqual(['o1']);
    expect(fp.evaluate(p, 'contained.ofType(Patient)')).toEqual([]);
  });

  it('evaluates on a backbone element with its type', () => {
    const pat1 =
      'name.exists() or telecom.exists() or address.exists() or organization.exists()';
    expect(
      fp
        .compile(pat1)
        .test(p.contact![0], { type: 'Patient.contact', resource: p }),
    ).toBe(true);
    expect(fp.evaluate(p, 'contact.children().count()')).toEqual([1]);
  });

  it('matches a FHIR primitive with its System type only when lenient (R4 que-7: answer is Boolean)', () => {
    const input = { answerBoolean: true };
    const options = { type: 'Questionnaire.item.enableWhen' };
    expect(lenient.evaluate(input, 'answer is Boolean', options)).toEqual([
      true,
    ]);
    expect(fp.evaluate(input, 'answer is Boolean', options)).toEqual([false]);
    expect(fp.evaluate(input, 'answer is boolean', options)).toEqual([true]);
  });

  /*
   * Every R4 invariant on every node of every valid R4 example, against
   * fhirpath.js (HL7's JavaScript FHIRPath, a development dependency only)
   */
  it('gives what fhirpath.js gives on every R4 invariant of the R4 examples #slow', function () {
    if (!hasPackage(R4_EXAMPLES)) return this.skip();
    this.timeout(180000);
    const require = createRequire(import.meta.url);
    const fpjs = require('fhirpath');
    const r4ctx = require('fhirpath/fhir-context/r4');
    const theirs = new Map<string, any>();
    const st = { evaluated: 0, same: 0, ourErrors: 0, theirErrors: 0 };
    const differ: string[] = [];
    const outcome = (r: unknown[]) =>
      r.length === 0
        ? 'empty'
        : r.length === 1 && typeof r[0] === 'boolean'
          ? String(r[0])
          : 'true';
    const constraintsOf = (t: FhirTypeInfo) => {
      const out: FhirConstraintOptions[] = [];
      for (let x: FhirTypeInfo | undefined = t; x; x = x.base)
        out.push(...x.constraints);
      return out;
    };
    const check = (
      node: any,
      type: FhirTypeInfo,
      root: any,
      resource: any,
      where: string,
    ) => {
      for (const c of constraintsOf(type)) {
        if (!c.expression) continue;
        st.evaluated++;
        let a: string | undefined;
        let b: string | undefined;
        try {
          a = outcome(
            lenient.evaluate(node, c.expression, {
              type: type.path,
              resource,
              rootResource: root,
            }),
          );
        } catch {
          st.ourErrors++;
          continue;
        }
        const key = type.path + '\u0000' + c.expression;
        if (!theirs.has(key))
          theirs.set(
            key,
            fpjs.compile({ base: type.path, expression: c.expression }, r4ctx, {
              traceFn: () => {},
            }),
          );
        try {
          b = outcome(theirs.get(key)(node, { resource, rootResource: root }));
        } catch {
          st.theirErrors++;
          continue;
        }
        if (a === b) st.same++;
        else differ.push(`${c.key} ${where}: ours ${a}, fhirpath.js ${b}`);
      }
      for (const el of type.elements.values())
        for (const et of el.types) {
          const v = node[et.key];
          if (v === undefined || v === null) continue;
          const t = r4Model.getType(et.code);
          if (t.kind === 'primitive-type') continue;
          (Array.isArray(v) ? v : [v]).forEach((it: any, i: number) => {
            if (!it || typeof it !== 'object') return;
            const w = `${where}.${et.key}${Array.isArray(v) ? `[${i}]` : ''}`;
            if (t.kind !== 'resource') check(it, t, root, resource, w);
            // contained: %resource is it, %rootResource the container; Bundle.entry.resource: itself
            else
              check(
                it,
                r4Model.getType(it.resourceType),
                et.key === 'contained' ? root : it,
                it,
                w,
              );
          });
        }
    };
    for (const file of fs.readdirSync(R4_EXAMPLES)) {
      if (
        !file.endsWith('.json') ||
        file === 'package.json' ||
        file.startsWith('.')
      )
        continue;
      let res: any;
      try {
        res = fhir.decode(
          JSON.parse(fs.readFileSync(path.join(R4_EXAMPLES, file), 'utf8')),
        );
      } catch {
        continue; // the 13 invalid examples
      }
      check(
        res,
        r4Model.getType(res.resourceType),
        res,
        res,
        `${file} ${res.resourceType}`,
      );
    }
    expect(st.ourErrors).toBe(0);
    // fhirpath.js: regexes of eld-16/19/20 in JavaScript's u mode, resolve() without async
    expect(st.theirErrors).toBe(95982);
    // R4's que-7 asks "answer is Boolean" of a FHIR boolean: true here, false in fhirpath.js
    expect(differ).toEqual([
      'que-7 Questionnaire-bb.json Questionnaire.item[0].item[1].item[2].item[0].enableWhen[0]: ours true, fhirpath.js false',
    ]);
    expect(st.same).toBe(1903909);
  });

  describe('check()', () => {
    const issues = (expr: string, type: string | string[]) =>
      fp
        .check(expr, { type })
        .map(i => `${expr.slice(i.start, i.end)}: ${i.message}`);

    it('finds elements a type does not have, with their place', () => {
      expect(issues('name.given1', 'Patient')).toEqual([
        'name.given1: HumanName has no element "given1"',
      ]);
      expect(issues("name.where(use = 'official').given", 'Patient')).toEqual(
        [],
      );
      expect(issues('Encounter.name', 'Patient')).toEqual([
        'Encounter: Encounter is not the type of the input (Patient), nor one of its elements',
      ]);
    });

    it('takes a choice by its name, by its JSON key only when lenient', () => {
      expect(issues('value.unit', 'Observation')).toEqual([]);
      expect(issues('valueQuantity', 'Observation')).toEqual([
        'valueQuantity: Observation has no element "valueQuantity"',
      ]);
      expect(lenient.check('valueQuantity', { type: 'Observation' })).toEqual(
        [],
      );
    });

    it('fails a function only when no type of its input fits', () => {
      expect(issues('effective.toString()', 'Observation')).toEqual([]);
      expect(issues('$this.toString()', ['Period', 'Timing'])).toEqual([
        '$this.toString(): toString() takes a primitive value, not Period | Timing',
      ]);
    });

    it('narrows $this by type tests (implies, and, or, iif)', () => {
      expect(
        issues('$this is dateTime implies $this.toString().length() > 10', [
          'dateTime',
          'Period',
        ]),
      ).toEqual([]);
      expect(
        issues('$this is Period or $this.toString().length() > 10', [
          'dateTime',
          'Period',
        ]),
      ).toEqual([]);
      expect(
        issues('$this is Period and $this.toString().length() > 10', [
          'dateTime',
          'Period',
        ]),
      ).toHaveLength(1);
    });

    it('finds order taken from an unordered collection, unknown types and variables', () => {
      expect(issues('children().first()', 'Patient')).toEqual([
        'children().first(): first() needs an ordered collection; children() and descendants() give none',
      ]);
      expect(issues('name.ofType(Nme)', 'Patient')).toEqual([
        'Nme: Unknown type Nme',
      ]);
      expect(issues('%foo', 'Patient')).toEqual([
        '%foo: Unknown variable %foo',
      ]);
      expect(
        issues("defineVariable('n', name).select(%n.given)", 'Patient'),
      ).toEqual([]);
    });

    it('finds operands arithmetic and ordering do not take', () => {
      expect(issues('name.given.first() + 1', 'Patient')).toEqual([
        'name.given.first() + 1: Cannot apply "+" to string and System.Integer',
      ]);
      expect(issues('active * 2', 'Patient')).toEqual([
        'active * 2: Cannot apply "*" to boolean and System.Integer',
      ]);
      expect(issues("1 'mg' div 2", 'Patient')).toEqual([
        `1 'mg' div 2: Cannot apply "div" to System.Quantity and System.Integer`,
      ]);
      expect(issues("name < 'a'", 'Patient')).toEqual([
        `name < 'a': Cannot apply "<" to HumanName and System.String`,
      ]);
      expect(issues('birthDate < 5', 'Patient')).toEqual([
        'birthDate < 5: Cannot apply "<" to date and System.Integer',
      ]);
      expect(issues('(value as Quantity) + 3', 'Observation')).toEqual([
        '(value as Quantity) + 3: Cannot apply "+" to Quantity and System.Integer',
      ]);
      expect(issues('(value as Period).unit', 'Observation')).toEqual([
        '(value as Period).unit: Period has no element "unit"',
      ]);
    });

    it('takes the operands evaluation takes', () => {
      for (const e of [
        "name.given.first() + 'x'",
        '5 div 2.0',
        "(value as Quantity) * 2 + 3 'mg'",
        "birthDate + 1 year < today() and birthDate > '1900-01-01'",
        "@T10:00 < @T11:00 and 2 'kg' >= 1 'kg'",
      ])
        expect(issues(e, ['Patient', 'Observation'])).toEqual([]);
      // a choice: one type that fits is enough (multipleBirth is boolean or integer)
      expect(issues('multipleBirth div 2', 'Patient')).toEqual([]);
      expect(issues('value * 2', 'Observation')).toEqual([]);
      // equality takes any operands; values of different types are not equal
      expect(issues("name.first() = 'Peter'", 'Patient')).toEqual([]);
    });

    it("reads a primitive's value element", () => {
      expect(issues('active.value', 'Patient')).toEqual([]);
      expect(
        fp.evaluate({ resourceType: 'Patient', active: true }, 'active.value'),
      ).toEqual([true]);
    });
  });
});
