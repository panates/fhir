import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FhirClient } from '@fhirjs/client';
import { FhirContext } from '@fhirjs/core';
import { Patient, r4Model } from '@fhirjs/r4';
import { expect } from 'expect';
import {
  dateRange,
  FhirServer,
  type FhirStore,
  MemoryStore,
  nodeListener,
  type SearchQuery,
  type StoreCapabilities,
} from '../src/index.js';

const fhir = new FhirContext(r4Model);
const TCKN = 'urn:oid:2.16.840.1.113883.3.9900.1';
const LOINC = 'http://loinc.org';

const RESOURCES = [
  {
    resourceType: 'Patient',
    id: 'p1',
    name: [{ family: 'Yılmaz', given: ['Ayşe'] }],
    gender: 'female',
    birthDate: '1980-02-03',
    identifier: [{ system: TCKN, value: '10000000146' }],
    address: [{ city: 'İstanbul' }],
  },
  {
    resourceType: 'Patient',
    id: 'p2',
    name: [{ family: 'Kaya', given: ['Mehmet'] }],
    gender: 'male',
    birthDate: '1990-06-15',
    identifier: [
      { system: TCKN, value: '20000000146' },
      { system: 'urn:x', value: 'A1' },
    ],
  },
  {
    resourceType: 'Patient',
    id: 'p3',
    name: [{ family: 'Öztürk', given: ['Ali'] }],
    gender: 'male',
    birthDate: '1980',
  },
  {
    resourceType: 'Observation',
    id: 'o1',
    status: 'final',
    code: { coding: [{ system: LOINC, code: '1234-5', display: 'Glucose' }] },
    subject: { reference: 'Patient/p1' },
    effectiveDateTime: '2020-03-04T10:00:00Z',
  },
  {
    resourceType: 'Observation',
    id: 'o2',
    status: 'preliminary',
    code: { coding: [{ system: LOINC, code: '9999-9' }], text: 'Cholesterol' },
    subject: { reference: 'Patient/p2' },
    effectivePeriod: { start: '2021-01-01', end: '2021-01-31' },
  },
  {
    resourceType: 'Observation',
    id: 'o3',
    status: 'final',
    code: {
      coding: [
        { system: 'http://snomed.info/sct', code: '22253000', display: 'Pain' },
      ],
    },
    subject: { reference: 'Group/g1' },
  },
];

async function start(server: FhirServer) {
  const httpServer = http.createServer(nodeListener(server));
  await new Promise<void>(r => httpServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/fhir`;
  return {
    base,
    client: new FhirClient({ baseUrl: base, fhir }),
    fetch: (path: string, init: RequestInit = {}) =>
      fetch(`${base}/${path}`, init),
    stop: () => new Promise<void>(r => httpServer.close(() => r())),
  };
}

describe('FhirServer search over a MemoryStore', () => {
  let s: Awaited<ReturnType<typeof start>>;
  let startedAt: string;

  /** The ids a search finds, sorted */
  const ids = async (query: string): Promise<string[]> => {
    const r = await s.fetch(query);
    const bundle = await r.json();
    if (r.status !== 200)
      throw new Error(`${query}: ${r.status} ${JSON.stringify(bundle)}`);
    return (bundle.entry ?? []).map((e: any) => e.resource.id).sort();
  };
  const refused = async (
    query: string,
    init?: RequestInit,
  ): Promise<string> => {
    const r = await s.fetch(query, init);
    const json = await r.json();
    return `${r.status} ${json.issue?.map((i: any) => i.diagnostics).join('; ')}`;
  };

  before(async () => {
    startedAt = new Date().toISOString();
    s = await start(
      new FhirServer({ fhir, store: new MemoryStore(), base: '/fhir' }),
    );
    for (const r of RESOURCES) {
      const res = await s.fetch(`${r.resourceType}/${r.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/fhir+json' },
        body: JSON.stringify(r),
      });
      expect(res.status).toBe(201);
    }
  });
  after(() => s.stop());

  it('finds strings by their start, without case or accents (Turkish ı and İ too)', async () => {
    expect(await ids('Patient?name=yilm')).toEqual(['p1']);
    expect(await ids('Patient?name=OZT')).toEqual(['p3']);
    expect(await ids('Patient?name=ayse')).toEqual(['p1']);
    expect(await ids('Patient?address-city=istanbul')).toEqual(['p1']);
    expect(await ids('Patient?family=kaya,yilmaz')).toEqual(['p1', 'p2']);
    expect(await ids('Patient?name:exact=Yılmaz')).toEqual(['p1']);
    expect(await ids('Patient?name:exact=yılmaz')).toEqual([]);
    expect(await ids('Patient?name:contains=aya')).toEqual(['p2']);
  });

  it('finds tokens: codes, system|code, system|, Identifier values, :not, :text, :missing', async () => {
    expect(await ids('Patient?gender=male')).toEqual(['p2', 'p3']);
    expect(await ids('Patient?gender=female,male')).toEqual(['p1', 'p2', 'p3']);
    expect(await ids(`Patient?identifier=${TCKN}|10000000146`)).toEqual(['p1']);
    expect(await ids('Patient?identifier=10000000146')).toEqual(['p1']);
    expect(await ids(`Patient?identifier=${TCKN}|`)).toEqual(['p1', 'p2']);
    expect(await ids('Patient?identifier=urn:x|A1')).toEqual(['p2']);
    // |A1: an identifier without a system; A1 has one
    expect(await ids('Patient?identifier=|A1')).toEqual([]);
    expect(await ids('Patient?gender:not=male')).toEqual(['p1']);
    expect(await ids('Patient?identifier:missing=true')).toEqual(['p3']);
    expect(await ids('Patient?_id=p1,p3')).toEqual(['p1', 'p3']);
    expect(await ids(`Observation?code=${LOINC}|1234-5`)).toEqual(['o1']);
    expect(await ids('Observation?code=1234-5')).toEqual(['o1']);
    expect(await ids('Observation?code:text=gluc')).toEqual(['o1']);
    expect(await ids('Observation?code:text=chol')).toEqual(['o2']);
  });

  it('finds dates by their ranges and prefixes', async () => {
    expect(await ids('Patient?birthdate=1980')).toEqual(['p1', 'p3']);
    // 1980 (the whole year) is not within February
    expect(await ids('Patient?birthdate=1980-02')).toEqual(['p1']);
    expect(await ids('Patient?birthdate=ge1985')).toEqual(['p2']);
    expect(await ids('Patient?birthdate=lt1985')).toEqual(['p1', 'p3']);
    expect(await ids('Patient?birthdate=ne1980')).toEqual(['p2']);
    expect(await ids('Patient?birthdate=sa1980')).toEqual(['p2']);
    expect(await ids('Patient?birthdate=eb1990')).toEqual(['p1', 'p3']);
    expect(await ids('Patient?birthdate=ge1970&birthdate=lt1985')).toEqual([
      'p1',
      'p3',
    ]);
    // a Period: within a month, not within a day of it
    expect(await ids('Observation?date=2021-01')).toEqual(['o2']);
    expect(await ids('Observation?date=2021-01-15')).toEqual([]);
    expect(await ids('Observation?date=gt2021-01-10')).toEqual(['o2']);
    expect(await ids('Observation?date=2020-03-04T10:00Z')).toEqual(['o1']);
    expect(await ids('Observation?date:missing=true')).toEqual(['o3']);
    expect(
      await ids(`Patient?_lastUpdated=ge${encodeURIComponent(startedAt)}`),
    ).toEqual(['p1', 'p2', 'p3']);
  });

  it('finds references by type and id, id alone, the type modifier, an absolute URL of this server', async () => {
    expect(await ids('Observation?subject=Patient/p1')).toEqual(['o1']);
    expect(await ids('Observation?subject=p1')).toEqual(['o1']);
    expect(await ids('Observation?subject:Patient=p2')).toEqual(['o2']);
    expect(await ids('Observation?subject=Group/g1')).toEqual(['o3']);
    // patient: subject.where(resolve() is Patient)
    expect(await ids('Observation?patient=p1')).toEqual(['o1']);
    expect(await ids('Observation?patient=Patient/p2')).toEqual(['o2']);
    expect(await ids('Observation?patient=g1')).toEqual([]);
    expect(await ids(`Observation?subject=${s.base}/Patient/p1`)).toEqual([
      'o1',
    ]);
    expect(
      await ids('Observation?subject=http://elsewhere/fhir/Patient/p1'),
    ).toEqual([]);
  });

  it('pages with _count, and links the pages', async () => {
    const first = await (
      await s.fetch('Patient?gender=female,male&_count=2')
    ).json();
    expect(first).toMatchObject({
      resourceType: 'Bundle',
      type: 'searchset',
      total: 3,
    });
    expect(first.entry).toHaveLength(2);
    expect(first.entry[0].search).toEqual({ mode: 'match' });
    expect(first.entry[0].fullUrl).toBe(
      `${s.base}/Patient/${first.entry[0].resource.id}`,
    );
    const next = first.link.find((l: any) => l.relation === 'next').url;
    expect(next).toBe(
      `${s.base}/Patient?gender=female%2Cmale&_count=2&_offset=2`,
    );
    const second = await (await fetch(next)).json();
    expect(second.entry).toHaveLength(1);
    expect(second.link.map((l: any) => l.relation)).toEqual([
      'self',
      'previous',
    ]);
    expect(fhir.validate(first).valid).toBe(true);
    // through the client, which follows next
    const all = await (
      await s.client.search(Patient, { gender: 'male', _count: 1 })
    ).all();
    expect(all.map(p => p.id).sort()).toEqual(['p2', 'p3']);
    expect(all[0]).toBeInstanceOf(Patient);
  });

  it('searches with POST [type]/_search and a form', async () => {
    const r = await s.fetch('Patient/_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'gender=male',
    });
    expect((await r.json()).total).toBe(2);
    expect(
      (await s.client.search(Patient, { gender: 'male' }, { method: 'POST' }))
        .bundle.total,
    ).toBe(2);
    expect(
      await refused('Patient/_search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    ).toBe(
      '415 _search takes a form (application/x-www-form-urlencoded), not application/json',
    );
  });

  it('leaves out an unknown parameter, and refuses it with handling=strict', async () => {
    const r = await (
      await s.fetch('Patient?foo=1&gender=male&value-quantity=5')
    ).json();
    expect(r.total).toBe(2);
    expect(r.link[0].url).toBe(`${s.base}/Patient?gender=male&_count=50`);
    expect(
      await refused('Patient?foo=1', {
        headers: { Prefer: 'handling=strict' },
      }),
    ).toBe('400 Unknown search parameter foo for Patient');
  });

  it('refuses values and modifiers it cannot read (400)', async () => {
    expect(await refused('Patient?name:text=x')).toBe(
      '400 name:text: the modifier is not supported',
    );
    expect(await refused('Patient?birthdate=19x')).toBe(
      '400 birthdate: "19x" is not a date',
    );
    expect(await refused('Patient?birthdate=2020-02-30')).toBe(
      '400 birthdate: "2020-02-30" is not a date',
    );
    expect(await refused('Patient?gender:missing=maybe')).toBe(
      '400 gender:missing takes true or false, not "maybe"',
    );
    expect(await refused('Observation?subject=Medication/1')).toBe(
      '400 subject: a reference to Group, Device, Patient, Location, not Medication',
    );
    expect(await refused('Patient?gender=')).toBe('400 gender: an empty value');
  });

  it('lists the parameters it searches in the CapabilityStatement', async () => {
    const cs = await s.client.capabilities();
    const patient = cs.rest[0].resource.find((r: any) => r.type === 'Patient');
    const byName = Object.fromEntries(
      patient.searchParam.map((p: any) => [p.name, p.type]),
    );
    expect(byName).toMatchObject({
      birthdate: 'date',
      name: 'string',
      identifier: 'token',
      'general-practitioner': 'reference',
      _id: 'token',
      _lastUpdated: 'date',
    });
    // number, quantity, uri and composite parameters are the next step
    expect(
      Object.values(byName).every(t =>
        ['token', 'string', 'date', 'reference'].includes(t as string),
      ),
    ).toBe(true);
    expect(fhir.validate(cs).valid).toBe(true);
  });
});

describe('FhirServer search through a store of its own', () => {
  /** A facade that searches its table by TC identity number only */
  class Tckn implements FhirStore {
    queries: SearchQuery[] = [];
    capabilities(type: string): StoreCapabilities | undefined {
      return type === 'Patient'
        ? {
            interactions: ['search'],
            versions: 'none',
            searchParams: ['identifier'],
          }
        : undefined;
    }
    async search(type: string, query: SearchQuery) {
      this.queries.push(query);
      const value = query.criteria[0]?.values[0]?.code;
      return {
        items:
          value === '10000000146'
            ? [
                {
                  type,
                  id: value,
                  resource: { resourceType: 'Patient', id: value },
                },
              ]
            : [],
        total: value === '10000000146' ? 1 : 0,
      };
    }
  }

  it('gives the store the parsed criteria, and only the parameters it names', async () => {
    const store = new Tckn();
    const server = new FhirServer({
      fhir,
      stores: { Patient: store },
      resources: ['Patient'],
    });
    const r = await server.handle(
      new Request(
        `http://localhost/Patient?identifier=${TCKN}|10000000146&name=x`,
      ),
    );
    const bundle = await r.json();
    expect(bundle.total).toBe(1);
    expect(bundle.link[0].url).toBe(
      `http://localhost/Patient?identifier=${encodeURIComponent(`${TCKN}|10000000146`)}&_count=50`,
    );
    const [c] = store.queries[0].criteria;
    expect(store.queries[0].criteria).toHaveLength(1);
    expect(c.param.code).toBe('identifier');
    expect(c.values).toEqual([
      { raw: `${TCKN}|10000000146`, system: TCKN, code: '10000000146' },
    ]);
    const strict = await server.handle(
      new Request('http://localhost/Patient?name=x', {
        headers: { Prefer: 'handling=strict' },
      }),
    );
    expect(strict.status).toBe(400);
    const cs = server.capabilityStatement('http://localhost');
    expect(cs.rest[0].resource[0].searchParam.map((p: any) => p.name)).toEqual([
      'identifier',
    ]);
  });

  it('refuses a store that names a parameter the type does not have', () => {
    const store = new Tckn();
    store.capabilities = () => ({
      interactions: ['search'],
      versions: 'none',
      searchParams: ['tckn'],
    });
    expect(
      () =>
        new FhirServer({
          fhir,
          stores: { Patient: store },
          resources: ['Patient'],
        }),
    ).toThrow(
      'The store of Patient names a search parameter Patient does not have: tckn',
    );
  });
});

describe('dateRange()', () => {
  const iso = (r: [number, number] | undefined) =>
    r && r.map(x => new Date(x).toISOString());
  it('gives the instants a date covers, [start, end)', () => {
    expect(iso(dateRange('2020'))).toEqual([
      '2020-01-01T00:00:00.000Z',
      '2021-01-01T00:00:00.000Z',
    ]);
    expect(iso(dateRange('2020-02'))).toEqual([
      '2020-02-01T00:00:00.000Z',
      '2020-03-01T00:00:00.000Z',
    ]);
    expect(iso(dateRange('2020-12-31'))).toEqual([
      '2020-12-31T00:00:00.000Z',
      '2021-01-01T00:00:00.000Z',
    ]);
    expect(iso(dateRange('2020-03-04T10:00+03:00'))).toEqual([
      '2020-03-04T07:00:00.000Z',
      '2020-03-04T07:01:00.000Z',
    ]);
    expect(iso(dateRange('2020-03-04T10:00:05.5Z'))).toEqual([
      '2020-03-04T10:00:05.500Z',
      '2020-03-04T10:00:05.600Z',
    ]);
    expect(dateRange('2020-13')).toBeUndefined();
    expect(dateRange('2021-02-29')).toBeUndefined();
    expect(dateRange('yesterday')).toBeUndefined();
  });
});
