/**
 * The EMR facade against the meaning of each search parameter: the same
 * searches on a server over the facade (SQL) and on a server over the same
 * resources matched by FHIRPath (as the memory store matches) must find the
 * same resources, in the same order. Needs PostgreSQL: FHIR_PG_URL
 * (postgres://postgres@localhost:5432/postgres); skipped without it.
 */
import { FhirContext } from '@fhirjs/core';
import { r4Model } from '@fhirjs/r4';
import {
  type FhirStore,
  FhirServer,
  type SearchQuery,
  type StorePage,
  type StoredResource,
} from '@fhirjs/server';
import type { SqbClient } from '@sqb/connect';
import { expect } from 'expect';
import { clientOf, createSchema, dropSchema } from '../db.js';
import { EmrStore } from '../emr-store.js';

const fhir = new FhirContext(r4Model);
const TYPES = ['Patient', 'Encounter', 'Observation'];
const URL_ = process.env.FHIR_PG_URL;

/** The facade's resources, kept as they are and matched by FHIRPath */
class FixtureStore implements FhirStore {
  constructor(
    private readonly _emr: EmrStore,
    private readonly _all: Map<string, Record<string, any>[]>,
  ) {}

  capabilities(type: string) {
    return this._emr.capabilities(type);
  }

  async read(type: string, id: string) {
    const r = this._all.get(type)?.find(x => x.id === id);
    return r && stored(r);
  }

  async search(
    type: string,
    query: SearchQuery,
  ): Promise<StorePage<StoredResource>> {
    const lookup = {
      read: (t: string, id: string) => this._all.get(t)?.find(x => x.id === id),
      all: (t: string) => this._all.get(t) ?? [],
    };
    const found = (this._all.get(type) ?? []).filter(r =>
      query.matches(r, lookup),
    );
    if (query.sort.length) found.sort((a, b) => query.compare(a, b));
    return {
      items: found.slice(query.offset, query.offset + query.count).map(stored),
      total: found.length,
    };
  }
}

const stored = (r: Record<string, any>): StoredResource => ({
  type: r.resourceType,
  id: r.id,
  resource: r,
  lastUpdated: r.meta?.lastUpdated,
});

describe('examples/facade: an EMR in PostgreSQL behind a FHIR server', function () {
  const schema = `facade_${Math.random().toString(36).slice(2, 10)}`;
  let admin: SqbClient;
  let client: SqbClient;
  let emr: EmrStore;
  let sql: FhirServer;
  let memory: FhirServer;
  let all: Map<string, Record<string, any>[]>;

  before(async function () {
    if (!URL_) return this.skip();
    admin = clientOf(URL_);
    await createSchema(admin, schema);
    client = clientOf(URL_, schema);
    emr = new EmrStore({ client });
    all = new Map();
    for (const type of TYPES) {
      const page = await emr.search(type, {
        type,
        criteria: [],
        sort: [],
        count: 1000,
        offset: 0,
        matches: () => true,
        compare: () => 0,
      });
      all.set(
        type,
        page.items.map(s => s.resource!),
      );
    }
    sql = new FhirServer({ fhir, store: emr, resources: TYPES });
    memory = new FhirServer({
      fhir,
      store: new FixtureStore(emr, all),
      resources: TYPES,
    });
  });

  after(async () => {
    await client?.close();
    if (admin) {
      await dropSchema(admin, schema);
      await admin.close();
    }
  });

  /** A search's answer: its status, total and ids in order, or its error */
  const answer = async (server: FhirServer, path: string) => {
    const r = await server.handle(
      new Request(`http://localhost/${path}`, {
        headers: { Prefer: 'handling=strict' },
      }),
    );
    const body = await r.json();
    if (r.status !== 200) return `${r.status} ${body.issue[0].diagnostics}`;
    return `${body.total} ${(body.entry ?? [])
      .map(
        (e: any) =>
          `${e.search?.mode === 'include' ? '+' : ''}${e.resource.id}`,
      )
      .join(',')}`;
  };

  /** Each search on both servers: the answers must be the same */
  const same = async (paths: string[]) => {
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const path of paths) {
      got[path] = await answer(sql, path);
      want[path] = await answer(memory, path);
    }
    expect(got).toEqual(want);
    // the searches find something, most of them
    const found = Object.values(want).filter(a => !/^0 /.test(a));
    expect(found.length).toBeGreaterThan(paths.length / 2);
    return want;
  };

  it('maps every row to a valid resource, and reads it', async () => {
    expect([...all.values()].map(l => l.length)).toEqual([20, 40, 200]);
    for (const list of all.values())
      for (const r of list)
        expect([
          r.resourceType,
          r.id,
          fhir.validate(r).issues.filter(i => i.severity === 'error'),
        ]).toEqual([r.resourceType, r.id, []]);
    const p = await (
      await sql.handle(new Request('http://localhost/Patient/1'))
    ).json();
    expect(p).toEqual(all.get('Patient')![0]);
    expect(p).toMatchObject({
      identifier: [{ value: 'MRN0001' }, { system: 'urn:example:national-id' }],
      name: [{ family: 'Yilmaz', given: ['Ali'] }],
      gender: 'male',
      birthDate: '1980-05-12',
    });
    const o = all.get('Observation')!.find(x => x.valueString);
    expect(o).toMatchObject({
      code: { coding: [{ code: '5778-6', display: 'Color of Urine' }] },
    });
  });

  it('searches patients as FHIR does', async () => {
    await same([
      'Patient?_id=1',
      'Patient?_id=1,2,999',
      'Patient?_id:not=1',
      'Patient?identifier=urn:example:mrn|MRN0003',
      'Patient?identifier=MRN0003',
      'Patient?identifier=urn:example:national-id|',
      'Patient?identifier=|MRN0003',
      'Patient?identifier:not=urn:example:mrn|MRN0001',
      'Patient?name=ali',
      'Patient?name=smith',
      'Patient?name=ANN',
      'Patient?name:exact=Smith',
      'Patient?name:contains=mit',
      'Patient?name=ozt',
      'Patient?name=ayse',
      'Patient?family=smith',
      'Patient?family:exact=Smith',
      'Patient?given=ann,mary',
      'Patient?gender=female',
      'Patient?gender=male,other',
      'Patient?gender:not=male',
      'Patient?gender=http://hl7.org/fhir/administrative-gender|male',
      'Patient?gender:missing=false',
      'Patient?birthdate=1980',
      'Patient?birthdate=1990-02',
      'Patient?birthdate=ge1980-01-01',
      'Patient?birthdate=lt1970',
      'Patient?birthdate=gt1980',
      'Patient?birthdate=gt1980-05-11',
      'Patient?birthdate=lt1980-05-13',
      'Patient?birthdate=le1985-11-30',
      'Patient?birthdate=ne1980-05-12',
      'Patient?birthdate=sa2000',
      'Patient?birthdate=eb1960',
      'Patient?birthdate:missing=true',
      'Patient?active=false',
      'Patient?active:not=true',
      'Patient?phone=%2B905550000001',
      'Patient?phone=phone|%2B905550000001',
      'Patient?phone=email|%2B905550000001',
      'Patient?phone:missing=true',
      'Patient?phone:not=%2B905550000001',
      'Patient?family:exact=Smith&address-city:missing=false',
      'Patient?email=ali.1@example.org',
      'Patient?email:missing=false',
      'Patient?address-city=ist',
      'Patient?address-city:missing=true',
      'Patient?name:missing=true',
      'Patient?name:missing=false',
      'Patient?given:missing=false',
      'Patient?identifier:missing=false',
      'Patient?deceased=true',
      'Patient?deceased=false',
      'Patient?_lastUpdated=ge2026-01-02',
      'Patient?_lastUpdated=lt2026-01-01T10:00:00Z',
      'Patient?name=smith&gender=female',
    ]);
  });

  it('sorts and pages as FHIR does', async () => {
    await same([
      'Patient?_sort=family',
      'Patient?_sort=-family',
      'Patient?_sort=birthdate',
      'Patient?_sort=-birthdate,family',
      'Patient?_sort=family&_count=5&_offset=5',
      'Observation?_sort=date&_count=10',
      'Observation?_sort=-date&_count=10',
      'Observation?_sort=-date&_count=7&_offset=14',
      'Observation?code=2339-0&_count=3&_offset=2',
      'Encounter?_sort=date',
      'Encounter?_sort=-date',
      'Encounter?_sort=-date&_count=8&_offset=8',
    ]);
  });

  it('searches encounters and lab results as FHIR does', async () => {
    await same([
      'Encounter?status=finished',
      'Encounter?status=in-progress',
      'Encounter?status:not=finished',
      'Encounter?class=IMP',
      'Encounter?class=http://terminology.hl7.org/CodeSystem/v3-ActCode|EMER',
      'Encounter?class=urn:x|EMER',
      'Encounter?patient=1',
      'Encounter?subject=Patient/1',
      'Encounter?subject:Patient=2',
      'Encounter?subject=Group/1',
      'Encounter?reason-code=I10',
      'Encounter?reason-code=http://hl7.org/fhir/sid/icd-10|E11.9',
      'Encounter?reason-code:missing=true',
      'Encounter?reason-code:not=I10',
      'Encounter?identifier=ENC00001',
      'Encounter?date=2025',
      'Encounter?date=2025-01-05',
      'Encounter?date=2025-02',
      'Encounter?date=ge2025-04-01',
      'Encounter?date=gt2025-04-01T00:00:00Z',
      'Encounter?date=le2025-02-01',
      'Encounter?date=lt2025-02-01',
      'Encounter?date=ne2025-01-05',
      'Encounter?date=sa2025-03-01',
      'Encounter?date=eb2025-03-01',
      'Encounter?date=ge2025-03-01&date=le2025-03-31',
      'Encounter?date:missing=true',
      'Encounter?date:missing=false',
      'Observation?code=2339-0',
      'Observation?code=http://loinc.org|718-7',
      'Observation?code=2339-0,718-7',
      'Observation?code:not=2339-0',
      'Observation?category=laboratory',
      'Observation?category=urn:x|laboratory',
      'Observation?status=preliminary',
      'Observation?status:not=final',
      'Observation?patient=3',
      'Observation?encounter=5',
      'Observation?encounter:missing=true',
      'Observation?subject=http://localhost/Patient/3',
      'Observation?subject=http://elsewhere/Patient/3',
      'Observation?date=ge2025-03-01',
      'Observation?date=2025-01-05',
      'Observation?date=lt2025-02',
      'Observation?date=gt2025-03-01T09:00:00Z',
      'Observation?date:missing=true',
      'Observation?value-quantity=gt100',
      'Observation?value-quantity=5.4',
      'Observation?value-quantity=le70|http://unitsofmeasure.org|mg/dL',
      'Observation?value-quantity=ap100',
      'Observation?value-quantity=ne13',
      'Observation?value-quantity=140|mmol/L',
      'Observation?value-quantity:missing=true',
      'Observation?_lastUpdated=ge2026-03-05',
    ]);
  });

  it('searches chains, reverse chains and a composite as FHIR does', async () => {
    await same([
      'Observation?code-value-quantity=2339-0$gt90',
      'Observation?code-value-quantity=http://loinc.org|718-7$lt12',
      'Observation?code-value-quantity=2339-0$gt90,718-7$lt12',
      'Observation?code-value-quantity:missing=false',
      'Observation?code-value-quantity:missing=true',
      'Observation?subject:Patient.name=doe',
      'Observation?subject:Patient.gender=female&code=718-7',
      'Observation?encounter.class=EMER',
      'Observation?encounter.status=finished&code=2160-0',
      'Observation?encounter.patient.name=smith',
      'Encounter?subject:Patient.name=smith',
      'Encounter?patient.gender=female',
      'Encounter?patient.birthdate=lt1970',
      'Encounter?_has:Observation:encounter:code=2339-0',
      'Patient?_has:Observation:patient:code=5778-6',
      'Patient?_has:Encounter:patient:class=EMER&gender=female',
      'Patient?_has:Observation:patient:value-quantity=gt150',
      'Patient?_has:Encounter:patient:_has:Observation:encounter:status=preliminary',
      'Observation?code=2339-0&_include=Observation:subject&_count=5',
      'Patient?_id=1&_revinclude=Encounter:patient',
    ]);
  });

  it('refuses what it does not answer', async () => {
    const refused = [
      'Patient?gender:text=male',
      'Observation?date=ap2025',
      'Patient?_sort=given',
    ];
    const answers: string[] = [];
    for (const path of refused) answers.push(await answer(sql, path));
    expect(answers).toEqual([
      '400 :text is not supported',
      '400 The prefix ap of a date is not supported',
      '400 Patient cannot be sorted by given',
    ]);
    const write = await sql.handle(
      new Request('http://localhost/Patient', {
        method: 'POST',
        headers: { 'Content-Type': 'application/fhir+json' },
        body: '{"resourceType":"Patient"}',
      }),
    );
    expect(write.status).toBe(405);
  });
});
