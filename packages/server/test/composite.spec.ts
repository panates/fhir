import { FhirContext } from '@fhirjs/core';
import { r4Model } from '@fhirjs/r4';
import { r5Model } from '@fhirjs/r5';
import { expect } from 'expect';
import { type FhirStore, FhirServer, MemoryStore } from '../src/index.js';

const fhir = new FhirContext(r4Model);
const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';

const coded = (code: string) => ({ coding: [{ system: LOINC, code }] });
const RESOURCES = [
  { resourceType: 'Patient', id: 'p1' },
  { resourceType: 'Patient', id: 'p2' },
  {
    resourceType: 'Observation',
    id: 'glucose',
    status: 'final',
    code: coded('2339-0'),
    subject: { reference: 'Patient/p1' },
    valueQuantity: { value: 5.4, system: UCUM, code: 'mmol/L' },
  },
  {
    resourceType: 'Observation',
    id: 'bp',
    status: 'final',
    code: coded('85354-9'),
    subject: { reference: 'Patient/p2' },
    component: [
      { code: coded('8480-6'), valueQuantity: { value: 120 } },
      { code: coded('8462-4'), valueQuantity: { value: 80 } },
    ],
  },
  {
    resourceType: 'Observation',
    id: 'note',
    status: 'final',
    code: coded('note'),
    valueString: 'a$b,c',
  },
];

async function serverOf(store: FhirStore = new MemoryStore()) {
  const server = new FhirServer({ fhir, store });
  for (const r of RESOURCES) await store.update!(r.resourceType, r.id, r);
  const search = async (path: string, strict = true) => {
    const r = await server.handle(
      new Request(`http://localhost/${path}`, {
        headers: strict ? { Prefer: 'handling=strict' } : {},
      }),
    );
    const body = await r.json();
    if (r.status !== 200) return `${r.status} ${body.issue[0].diagnostics}`;
    return (body.entry ?? []).map((e: any) => e.resource.id).join(',');
  };
  return { server, search };
}

describe('FhirServer: composite search parameters', () => {
  it('matches a value of each component, prefixes and systems included', async () => {
    const { search } = await serverOf();
    expect([
      await search(`Observation?code-value-quantity=${LOINC}|2339-0$gt5`),
      await search(`Observation?code-value-quantity=${LOINC}|2339-0$gt6`),
      await search(`Observation?code-value-quantity=2339-0$5.4|${UCUM}|mmol/L`),
      await search(`Observation?code-value-quantity=2339-0$5.4|${UCUM}|mg`),
      // OR between values
      await search('Observation?code-value-quantity=8480-6$1,2339-0$le9'),
    ]).toEqual(['glucose', '', 'glucose', '', 'glucose']);
  });

  it('matches the components in one item: a code and its own value', async () => {
    const { search } = await serverOf();
    expect([
      await search('Observation?component-code-value-quantity=8480-6$120'),
      await search('Observation?component-code-value-quantity=8462-4$80'),
      // 120 is the systolic one's value, not the diastolic one's
      await search('Observation?component-code-value-quantity=8462-4$120'),
      // a code of the resource or of a component
      await search('Observation?combo-code-value-quantity=8462-4$lt100'),
      await search('Observation?combo-code-value-quantity=2339-0$lt100'),
    ]).toEqual(['bp', 'bp', '', 'bp', 'glucose']);
  });

  it('reads escaped separators, and :missing', async () => {
    const { search } = await serverOf();
    expect([
      await search('Observation?code-value-string=note$a\\$b\\,c'),
      await search('Observation?code-value-string=note$a\\$x'),
      await search('Observation?code-value-quantity:missing=true'),
      await search('Observation?component-code-value-quantity:missing=false'),
    ]).toEqual(['note', '', 'bp,note', 'bp']);
  });

  it('is a criterion of a reverse chain like any other', async () => {
    const { search } = await serverOf();
    expect(
      await search(
        'Patient?_has:Observation:subject:component-code-value-quantity=8480-6$gt100',
      ),
    ).toBe('p2');
  });

  it('refuses what it cannot read, and sorting by a composite', async () => {
    const { search } = await serverOf();
    expect([
      await search('Observation?code-value-quantity=2339-0'),
      await search('Observation?code-value-quantity=2339-0$5$6'),
      await search('Observation?code-value-quantity=2339-0$'),
      await search('Observation?code-value-quantity=2339-0$high'),
      await search('Observation?code-value-quantity:exact=2339-0$5'),
      await search('Observation?_sort=code-value-quantity'),
    ]).toEqual([
      '400 code-value-quantity: "2339-0" needs 2 parts, separated by $',
      '400 code-value-quantity: "2339-0$5$6" needs 2 parts, separated by $',
      '400 code-value-quantity: "2339-0$" has an empty part',
      '400 value-quantity: "high" is not a quantity',
      '400 code-value-quantity:exact: the modifier is not supported',
      '400 Observation cannot be sorted by code-value-quantity',
    ]);
    // without strict handling, the refused sort is left out
    expect(await search('Observation?_sort=code-value-quantity', false)).toBe(
      'glucose,bp,note',
    );
  });

  it('gives the store the components, and lists composites in the CapabilityStatement', async () => {
    const memory = new MemoryStore();
    const seen: any[] = [];
    const spy: FhirStore = Object.assign(Object.create(memory), {
      search: (type: string, query: any) => {
        seen.push(query.criteria[0]);
        return memory.search(type, query);
      },
    });
    const { server, search } = await serverOf(spy);
    await search(`Observation?code-value-quantity=${LOINC}|2339-0$gt5`);
    const c = seen[0];
    expect(c.components.map((k: any) => [k.param.code, k.expression])).toEqual([
      ['code', 'code'],
      ['value-quantity', 'value.as(Quantity)'],
    ]);
    expect(c.values[0].components).toMatchObject([
      { system: LOINC, code: '2339-0' },
      { prefix: 'gt', number: 5 },
    ]);
    const observation = server
      .capabilityStatement('http://localhost')
      .rest[0].resource.find((r: any) => r.type === 'Observation');
    expect(
      observation.searchParam.filter((p: any) => p.type === 'composite').length,
    ).toBe(8);
  });

  it('leaves out the composites whose components the specification does not define (R5)', () => {
    const r5 = new FhirContext(r5Model);
    const server = new FhirServer({ fhir: r5, store: new MemoryStore() });
    const composites = server
      .capabilityStatement('http://localhost')
      .rest[0].resource.flatMap((r: any) =>
        (r.searchParam ?? []).filter((p: any) => p.type === 'composite'),
      );
    // 84 in R5; 11 refer to search parameters R5 does not have
    expect(composites.length).toBe(73);
    const memory = new MemoryStore();
    const naming: FhirStore = Object.assign(Object.create(memory), {
      capabilities: () => ({
        ...memory.capabilities(),
        searchParams: ['code-value-string'],
      }),
    });
    expect(
      () =>
        new FhirServer({ fhir: r5, store: naming, resources: ['Observation'] }),
    ).toThrow(
      'The store of Observation names a composite parameter whose components are not known: code-value-string',
    );
  });
});
