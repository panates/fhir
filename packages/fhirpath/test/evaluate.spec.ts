import { expect } from 'expect';
import { FhirPath, FhirPathError } from '../src/index.js';

/* Without a model: navigation follows the JSON keys */
const fp = new FhirPath();
const patient = {
  resourceType: 'Patient',
  id: 'p1',
  birthDate: '1985-04-12',
  _birthDate: {
    extension: [
      { url: 'http://x/time', valueDateTime: '1985-04-12T10:00:00+03:00' },
    ],
  },
  name: [
    {
      use: 'official',
      family: 'Yılmaz',
      given: ['Ayşe', null],
      _given: [null, { extension: [{ url: 'http://x/a', valueString: 'b' }] }],
    },
    { use: 'nickname', given: ['Ayşo'] },
  ],
  deceasedBoolean: false,
  contained: [{ resourceType: 'Organization', id: 'o1', name: 'Hastane' }],
  managingOrganization: { reference: '#o1' },
};
const ev = (e: string, input: unknown = patient) => fp.evaluate(input, e);

describe('FHIRPath evaluation (no model)', () => {
  it('navigates, flattening collections', () => {
    expect(ev('name.given')).toEqual(['Ayşe', null, 'Ayşo']);
    expect(ev("Patient.name.where(use = 'official').family")).toEqual([
      'Yılmaz',
    ]);
    expect(ev('name[1].given')).toEqual(['Ayşo']);
    expect(ev('name.family.first()')).toEqual(['Yılmaz']);
  });

  it('reads primitive extensions from the _x siblings', () => {
    expect(ev('name.given.extension.url')).toEqual(['http://x/a']);
    expect(ev("birthDate.extension('http://x/time').value")).toEqual([
      '1985-04-12T10:00:00+03:00',
    ]);
    expect(ev('name.given.count()')).toEqual([3]);
    expect(ev('name.given.where(hasValue()).count()')).toEqual([2]);
  });

  it('finds a choice by its name', () => {
    expect(ev('deceased')).toEqual([false]);
  });

  it('applies three-valued logic', () => {
    expect(ev('true and {}')).toEqual([]);
    expect(ev('false and {}')).toEqual([false]);
    expect(ev('true or {}')).toEqual([true]);
    expect(ev('{} implies false')).toEqual([]);
    expect(ev('false implies {}')).toEqual([true]);
    expect(ev('true xor false')).toEqual([true]);
    expect(ev('(true).not()')).toEqual([false]);
  });

  it('compares and computes', () => {
    expect(ev('1 + 2 * 3')).toEqual([7]);
    expect(ev('10 div 3 | 10 mod 3')).toEqual([3, 1]);
    expect(ev('7 / 2')).toEqual([3.5]);
    expect(ev("'a' + 'b' & {} & 'c'")).toEqual(['abc']);
    expect(ev('{} = 1')).toEqual([]);
    expect(ev("'Abc  d' ~ 'abc d'")).toEqual([true]);
    expect(ev('(1 | 2 | 2 | 3).count()')).toEqual([3]);
    expect(ev('2 in (1 | 2)')).toEqual([true]);
  });

  it('compares dates at their precision', () => {
    expect(ev('birthDate < @2000-01-01')).toEqual([true]);
    expect(ev('@2012-04 = @2012-04-15')).toEqual([]);
    expect(ev('@2012-04-15T10:00:00+02:00 = @2012-04-15T08:00:00Z')).toEqual([
      true,
    ]);
    expect(ev('@2020-01-31 + 1 month')).toEqual(['2020-02-29']);
    expect(ev('@2020-02-29 + 1 year')).toEqual(['2021-02-28']);
    expect(ev('@2020-01-01T10:00 + 90 minutes')).toEqual(['2020-01-01T11:30']);
  });

  it('compares quantities of the same unit', () => {
    expect(ev("5 'mg' > 3 'mg'")).toEqual([true]);
    expect(ev("5 'mg' = 5 'g'")).toEqual([false]);
    expect(ev("5 'mg' < 5 'g'")).toEqual([true]);
    expect(ev("1000 'mg' = 1 'g'")).toEqual([true]);
    // different dimensions: not comparable
    expect(ev("5 'mg' < 5 'm'")).toEqual([]);
  });

  it('has the functions of the specification', () => {
    expect(ev('name.select(given.first())')).toEqual(['Ayşe', 'Ayşo']);
    expect(ev('name.all(given.exists())')).toEqual([true]);
    expect(ev('name.given.distinct().count()')).toEqual([3]);
    expect(ev("'abcdef'.substring(2, 3)")).toEqual(['cde']);
    expect(ev("'abc'.matches('^a.c$') and 'abc'.startsWith('ab')")).toEqual([
      true,
    ]);
    expect(ev("'a-b-c'.replaceMatches('-', '+')")).toEqual(['a+b+c']);
    expect(ev("iif(name.exists(), 'yes', 'no')")).toEqual(['yes']);
    expect(ev('(1 | 2 | 3).aggregate($this + $total, 0)')).toEqual([6]);
    expect(ev("'12'.toInteger() + 1")).toEqual([13]);
    expect(ev('(1.50).toString()')).toEqual(['1.50']);
    expect(ev('1.587.lowBoundary()')).toEqual([1.5865]);
    expect(ev('@2024-02.highBoundary()')).toEqual(['2024-02-29']);
  });

  it('resolves contained resources and Bundle entries', () => {
    expect(ev('managingOrganization.resolve().name')).toEqual(['Hastane']);
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        {
          fullUrl: 'urn:uuid:1',
          resource: { resourceType: 'Patient', id: 'a' },
        },
        {
          fullUrl: 'http://x/Observation/b',
          resource: {
            resourceType: 'Observation',
            id: 'b',
            subject: { reference: 'urn:uuid:1' },
          },
        },
      ],
    };
    expect(
      fp.evaluate(
        bundle,
        'entry.resource.ofType(Observation).subject.resolve().id',
        { rootResource: bundle },
      ),
    ).toEqual(['a']);
  });

  it('has %resource, %rootResource, %context, %ucum and given variables', () => {
    expect(ev('%resource.id')).toEqual(['p1']);
    expect(ev('%ucum')).toEqual(['http://unitsofmeasure.org']);
    expect(ev('%`vs-administrative-gender`')).toEqual([
      'http://hl7.org/fhir/ValueSet/administrative-gender',
    ]);
    expect(
      fp.evaluate(patient, 'id = %expected', { vars: { expected: 'p1' } }),
    ).toEqual([true]);
  });

  it('raises errors for what the specification makes an error', () => {
    expect(() => ev('name.family = name.family and name.given < 1')).toThrow(
      FhirPathError,
    );
    expect(() => ev('nosuch()')).toThrow('Unknown function nosuch()');
    expect(() => ev('constructor()')).toThrow('Unknown function constructor()');
    expect(() => ev('%nope')).toThrow('Unknown variable %nope');
    expect(() => ev('name.single()')).toThrow('single() on 2 items');
  });

  it('test(): an expression as a condition', () => {
    expect(fp.compile('name.exists()').test(patient)).toBe(true);
    expect(fp.compile("name.where(use = 'old').exists()").test(patient)).toBe(
      false,
    );
    expect(
      fp.compile('photo.exists().not() and {}').test(patient),
    ).toBeUndefined();
  });

  it('caches compiled expressions', () => {
    expect(fp.compile('name.given')).toBe(fp.compile('name.given'));
  });
});
