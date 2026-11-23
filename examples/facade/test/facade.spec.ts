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
      'Patient?address-city=boston',
      'Patient?address-city:exact=Boston',
      'Patient?address-use=work',
      'Patient?address-use=http://hl7.org/fhir/address-use|home',
      'Patient?address-use:not=work',
      'Patient?address=4%20office',
      'Patient?address=tr&address-city=london',
      'Patient?phone=%2B902120000001',
      'Patient?phone=%2B905550000001,%2B902120000005',
      'Patient?email:not=ali.1@example.org',
      'Patient?email:missing=true&phone:missing=false',
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
      'Patient?_sort=address-city,family',
      'Patient?_sort=-address-city,family',
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
      'Encounter?reason-code=I10&reason-code=E11.9',
      'Encounter?reason-code=J18.9,R07.4',
      'Encounter?reason-code:missing=false&status=finished',
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
  });
});

describe('examples/facade: writes to the EMR', function () {
  const schema = `facadew_${Math.random().toString(36).slice(2, 10)}`;
  let admin: SqbClient;
  let client: SqbClient;
  let server: FhirServer;

  before(async function () {
    if (!URL_) return this.skip();
    admin = clientOf(URL_);
    await createSchema(admin, schema);
    client = clientOf(URL_, schema);
    server = new FhirServer({
      fhir,
      store: new EmrStore({ client }),
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

  const send = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const r = await server.handle(
      new Request(`http://localhost/${path}`, {
        method,
        headers: {
          ...(body === undefined
            ? {}
            : { 'Content-Type': 'application/fhir+json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
  };

  const refusal = async (method: string, path: string, body?: unknown) => {
    const r = await send(method, path, body);
    return `${r.status} ${r.body?.issue?.[0]?.diagnostics}`;
  };

  const withoutMeta = ({ meta: _m, ...r }: Record<string, any>) => r;

  it('writes every row back as it is: the mapping back is the inverse of the mapping', async () => {
    const changed: string[] = [];
    let n = 0;
    for (const type of TYPES) {
      const all = (await send('GET', `${type}?_count=1000`)).body.entry.map(
        (e: any) => e.resource,
      );
      for (const r of all) {
        n++;
        const w = await send('PUT', `${type}/${r.id}`, r, {
          'If-Match': `W/"${r.meta.versionId}"`,
        });
        if (
          w.status !== 200 ||
          JSON.stringify(withoutMeta(w.body)) !== JSON.stringify(withoutMeta(r))
        )
          changed.push(
            `${type}/${r.id}: ${w.status} ${w.body?.issue?.[0]?.diagnostics ?? ''}`,
          );
      }
    }
    expect(n).toBe(260);
    expect(changed).toEqual([]);
  });

  it('creates, updates and deletes; refuses what the EMR does not keep', async () => {
    const patient = {
      resourceType: 'Patient',
      identifier: [{ system: 'urn:example:mrn', value: 'MRN9001' }],
      active: true,
      name: [{ family: 'Çelik', given: ['Deniz', 'Su'] }],
      telecom: [{ system: 'email', value: 'deniz@example.org' }],
      gender: 'female',
      birthDate: '1995-04-01',
      address: [
        { use: 'home', line: ['1 Sea Road'], city: 'Izmir', country: 'TR' },
      ],
    };
    const created = await send('POST', 'Patient', patient);
    expect(created.status).toBe(201);
    const { id } = created.body;
    expect(withoutMeta(created.body)).toEqual({ ...patient, id });
    expect(
      (await send('GET', 'Patient?family=celik&given=su')).body.total,
    ).toBe(1);

    const encounter = {
      resourceType: 'Encounter',
      identifier: [{ system: 'urn:example:encounter', value: 'ENC90001' }],
      status: 'in-progress',
      class: {
        system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
        code: 'EMER',
      },
      subject: { reference: `Patient/${id}` },
      period: { start: '2026-11-23T09:30:00+03:00' },
    };
    const e = await send('POST', 'Encounter', encounter);
    expect(e.status).toBe(201);
    expect(e.body.class.display).toBe('emergency');
    expect(e.body.period).toEqual({ start: '2026-11-23T06:30:00.000Z' });
    expect(
      (await send('GET', `Encounter?patient=${id}&date=ge2026-11-23`)).body
        .total,
    ).toBe(1);
    const finished = await send('PUT', `Encounter/${e.body.id}`, {
      ...e.body,
      status: 'finished',
      period: { ...e.body.period, end: '2026-11-23T12:00:00.000Z' },
    });
    expect(finished.status).toBe(200);
    expect(finished.body.status).toBe('finished');

    expect([
      await refusal('POST', 'Patient', {
        ...patient,
        photo: [{ url: 'http://x/1.png' }],
      }),
      await refusal('POST', 'Patient', {
        ...patient,
        identifier: [{ system: 'urn:example:mrn', value: 'MRN9002' }],
        name: [{ family: 'Doe', given: ['A', 'B', 'C'] }],
      }),
      await refusal('POST', 'Patient', { resourceType: 'Patient' }),
      await refusal('POST', 'Patient', patient),
      await refusal('POST', 'Encounter', {
        ...encounter,
        class: { ...encounter.class, code: 'HH' },
      }),
      await refusal('DELETE', `Patient/${id}`),
    ]).toEqual([
      '422 The Patient has elements the table has no column for: Patient.photo',
      '422 The Patient has elements the database does not keep: Patient.name[0]',
      '422 The database refused a value of the Patient',
      '409 A Patient with the same unique value exists',
      '422 The database refused a value of the Encounter',
      '409 The Patient is referred to by other rows of the database',
    ]);

    // a decimal keeps the digits it is written with
    const lab = await server.handle(
      new Request('http://localhost/Observation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/fhir+json' },
        body: `{"resourceType":"Observation","status":"final","code":{"coding":[{"system":"http://loinc.org","code":"718-7"}]},"subject":{"reference":"Patient/${id}"},"valueQuantity":{"value":13.40,"unit":"g/dL","system":"http://unitsofmeasure.org","code":"g/dL"}}`,
      }),
    );
    expect(lab.status).toBe(201);
    const labId = Number((await lab.json()).id);
    const [row] = (
      await client.execute(
        `select value_numeric::text as v from lab_results where id = ${labId}`,
        { objectRows: true },
      )
    ).rows!;
    expect(row.v).toBe('13.40');
    expect((await send('DELETE', `Observation/${labId}`)).status).toBe(204);

    expect((await send('DELETE', `Encounter/${e.body.id}`)).status).toBe(204);
    expect((await send('DELETE', `Patient/${id}`)).status).toBe(204);
    expect((await send('GET', `Patient/${id}`)).status).toBe(404);
  });

  it('writes child rows by their key: kept rows keep their ids and the columns FHIR does not see', async () => {
    const rows = async (sql: string) =>
      (await client.execute(sql, { objectRows: true })).rows!;
    const telecoms = () =>
      rows(`select id::int, kind, value, rank, verified_at is not null as verified
              from patient_telecoms where patient_id = 1 order by rank`);
    const before = await telecoms();
    expect(before.map(t => [t.kind, t.value, t.rank, t.verified])).toEqual([
      ['phone', '+905550000001', 0, true],
      ['email', 'ali.1@example.org', 1, true],
      ['phone', '+902120000001', 2, true],
    ]);
    const p = (await send('GET', 'Patient/1')).body;
    expect(p.address.map((a: any) => a.use)).toEqual(['home', 'work']);

    // the phones swapped, the email changed, the work address gone
    const changed = {
      ...p,
      telecom: [
        { system: 'phone', value: '+902120000001' },
        { system: 'email', value: 'ali@example.org' },
        { system: 'phone', value: '+905550000001' },
      ],
      address: [{ ...p.address[0], city: 'Izmir' }],
    };
    const w = await send('PUT', 'Patient/1', changed);
    expect(w.status).toBe(200);
    expect(withoutMeta(w.body)).toEqual(withoutMeta(changed));
    const after = await telecoms();
    expect(after.map(t => [t.id, t.kind, t.value, t.rank, t.verified])).toEqual(
      [
        [before[2].id, 'phone', '+902120000001', 0, true],
        [after[1].id, 'email', 'ali@example.org', 1, false],
        [before[0].id, 'phone', '+905550000001', 2, true],
      ],
    );
    expect(after[1].id).not.toBe(before[1].id);
    expect(
      await rows(
        'select kind, city from patient_addresses where patient_id = 1',
      ),
    ).toEqual([{ kind: 'home', city: 'Izmir' }]);
    expect(
      (await send('GET', 'Patient?address-city=izmir&phone=%2B902120000001'))
        .body.total,
    ).toBe(1);

    // an encounter's diagnoses: the main one changed, then one removed
    const diagnoses = () =>
      rows(`select id::int, code, rank from encounter_diagnoses
             where encounter_id = 3 order by rank`);
    const d0 = await diagnoses();
    expect(d0.map(d => [d.code, d.rank])).toEqual([
      ['E11.9', 1],
      ['J18.9', 2],
    ]);
    const e = (await send('GET', 'Encounter/3')).body;
    const swapped = { ...e, reasonCode: [...e.reasonCode].reverse() };
    expect((await send('PUT', 'Encounter/3', swapped)).status).toBe(200);
    expect((await diagnoses()).map(d => [d.id, d.code, d.rank])).toEqual([
      [d0[1].id, 'J18.9', 1],
      [d0[0].id, 'E11.9', 2],
    ]);
    const one = { ...e, reasonCode: [e.reasonCode[1]] };
    expect((await send('PUT', 'Encounter/3', one)).status).toBe(200);
    expect((await diagnoses()).map(d => [d.id, d.code])).toEqual([
      [d0[1].id, 'J18.9'],
    ]);

    // refused, and nothing of them written
    const current = (await send('GET', 'Patient/1')).body;
    expect([
      await refusal('PUT', 'Patient/1', {
        ...current,
        telecom: [current.telecom[0], current.telecom[0]],
      }),
      await refusal('PUT', 'Patient/1', {
        ...current,
        address: [
          current.address[0],
          { ...current.address[0], city: 'Ankara' },
        ],
      }),
      await refusal('PUT', 'Patient/1', {
        ...current,
        telecom: [{ ...current.telecom[0], use: 'mobile' }],
      }),
      await refusal('PUT', 'Patient/1', {
        ...current,
        address: [{ ...current.address[0], use: 'temp' }],
      }),
      await refusal('PUT', 'Patient/1', {
        ...current,
        address: [{ ...current.address[0], line: ['1 Road', 'Flat 2'] }],
      }),
    ]).toEqual([
      '422 The Patient has two elements the database cannot tell apart',
      '422 The Patient has two addresses of the same use',
      '422 The Patient has elements the database does not keep: Patient.telecom[0]',
      '422 The database refused a value of the Patient',
      '422 The Patient has elements the database does not keep: Patient.address[0]',
    ]);
    expect((await send('GET', 'Patient/1')).body).toEqual(current);
    expect(await telecoms()).toEqual(after);

    // a patient deleted with its rows: telecoms by the store, addresses by the cascade
    const created = await send('POST', 'Patient', {
      resourceType: 'Patient',
      identifier: [{ system: 'urn:example:mrn', value: 'MRN9100' }],
      name: [{ family: 'Kurt', given: ['Ece'] }],
      telecom: [{ system: 'phone', value: '+905559999999' }],
      gender: 'female',
      address: [{ use: 'work', city: 'Ankara' }],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await send('DELETE', `Patient/${id}`)).status).toBe(204);
    expect(
      await rows(`select (select count(*) from patient_telecoms where patient_id = ${id})::int as t,
                         (select count(*) from patient_addresses where patient_id = ${id})::int as a`),
    ).toEqual([{ t: 0, a: 0 }]);
  });

  it('runs a transaction Bundle in one database transaction', async () => {
    const p = (await send('GET', 'Patient/2')).body;
    const lab = {
      resourceType: 'Observation',
      status: 'final',
      code: {
        coding: [
          {
            system: 'http://loinc.org',
            code: '718-7',
            display: 'Hemoglobin [Mass/volume] in Blood',
          },
        ],
      },
      subject: { reference: 'Patient/2' },
      effectiveDateTime: '2026-11-23T08:00:00.000Z',
      valueQuantity: {
        value: 13.4,
        unit: 'g/dL',
        system: 'http://unitsofmeasure.org',
        code: 'g/dL',
      },
    };
    const bundle = (labCode: string) => ({
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        {
          resource: {
            ...p,
            telecom: [{ system: 'phone', value: '+905550000999' }],
          },
          request: { method: 'PUT', url: 'Patient/2' },
        },
        {
          resource: {
            ...lab,
            code: { coding: [{ ...lab.code.coding[0], code: labCode }] },
          },
          request: { method: 'POST', url: 'Observation' },
        },
      ],
    });
    const labs = (await send('GET', 'Observation?patient=2&_summary=count'))
      .body.total;
    // the update fails after the create (a transaction creates, then
    // updates): the lab result is not kept either
    const failing = bundle('718-7');
    failing.entry[0].resource.photo = [{ url: 'http://x/1.png' }];
    expect((await send('POST', '', failing)).status).toBe(422);
    expect((await send('GET', 'Patient/2')).body).toEqual(p);
    expect(
      (await send('GET', 'Observation?patient=2&_summary=count')).body.total,
    ).toBe(labs);
    // a test the EMR's catalogue does not have
    expect((await send('POST', '', bundle('0000-0'))).status).toBe(422);
    const r = await send('POST', '', bundle('718-7'));
    expect(r.status).toBe(200);
    expect((await send('GET', 'Patient/2')).body.telecom).toEqual([
      { system: 'phone', value: '+905550000999' },
    ]);
    expect(
      (await send('GET', 'Observation?patient=2&_summary=count')).body.total,
    ).toBe(labs + 1);
  });
});
