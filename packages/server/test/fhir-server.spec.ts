import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FhirClient, FhirClientError } from '@fhirjs/client';
import { FhirContext } from '@fhirjs/core';
import { Observation, Patient, r4Model } from '@fhirjs/r4';
import { expect } from 'expect';
import {
  FhirServer,
  type FhirServerOptions,
  FhirServerError,
  type FhirStore,
  MemoryStore,
  nodeListener,
  type StoreCapabilities,
  type StoredResource,
  type StoredVersion,
} from '../src/index.js';

const fhir = new FhirContext(r4Model);
const FHIR_JSON = 'application/fhir+json';

/** A FhirServer on 127.0.0.1, under /fhir, with a client of it */
async function start(options: Partial<FhirServerOptions> = {}) {
  const server = new FhirServer({
    fhir,
    store: new MemoryStore(),
    base: '/fhir',
    ...options,
  });
  const httpServer = http.createServer(nodeListener(server));
  await new Promise<void>(r => httpServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/fhir`;
  return {
    server,
    base,
    client: new FhirClient({ baseUrl: base, fhir }),
    /** A request as it is, to see status and headers */
    fetch: (path: string, init: RequestInit = {}) =>
      fetch(`${base}/${path}`, init),
    stop: () => new Promise<void>(r => httpServer.close(() => r())),
  };
}
type Running = Awaited<ReturnType<typeof start>>;

const post = (
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': FHIR_JSON, ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const put = (
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit => ({
  ...post(body, headers),
  method: 'PUT',
});

async function rejects(p: Promise<unknown>): Promise<FhirClientError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FhirClientError) return e;
    throw e;
  }
  throw new Error('Expected a FhirClientError');
}

/** The status and the diagnostics of an OperationOutcome answer */
async function outcome(r: Response): Promise<string> {
  const json = await r.json();
  expect(json.resourceType).toBe('OperationOutcome');
  return `${r.status} ${json.issue.map((i: any) => i.diagnostics).join('; ')}`;
}

describe('FhirServer over a MemoryStore', () => {
  let s: Running;
  before(async () => (s = await start()));
  after(() => s.stop());

  it('creates and reads a resource, with its id, version and time', async () => {
    const created = await s.client.create(
      new Patient({
        name: [{ family: 'Yılmaz', given: ['Ayşe'] }],
        birthDate: '1980-02-03',
      }),
    );
    expect(created).toBeInstanceOf(Patient);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.meta!.versionId).toBe('1');
    expect(created.meta!.lastUpdated).toMatch(/^\d{4}-\d\d-\d\dT/);
    const read = await s.client.read(Patient, created.id!);
    expect(read.name![0].family).toBe('Yılmaz');
    expect(read.meta!.versionId).toBe('1');
  });

  it('answers a create with 201, Location, ETag and Last-Modified', async () => {
    const r = await s.fetch(
      'Patient',
      post({ resourceType: 'Patient', id: 'ignored', active: true }),
    );
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.id).not.toBe('ignored');
    expect(r.headers.get('Location')).toBe(
      `${s.base}/Patient/${body.id}/_history/1`,
    );
    expect(r.headers.get('ETag')).toBe('W/"1"');
    expect(new Date(r.headers.get('Last-Modified')!).getTime()).toBeGreaterThan(
      0,
    );
    expect(r.headers.get('Content-Type')).toBe(
      'application/fhir+json; charset=utf-8',
    );
  });

  it('keeps the places of a decimal', async () => {
    const r = await s.fetch(
      'Observation',
      post(
        '{"resourceType":"Observation","status":"final","code":{"text":"dose"},"valueQuantity":{"value":1.50,"unit":"mg"}}',
      ),
    );
    const text = await r.text();
    expect(text).toContain('"value":1.50');
    const id = JSON.parse(text).id;
    expect(await (await s.fetch(`Observation/${id}`)).text()).toContain(
      '"value":1.50',
    );
  });

  it('updates with If-Match, refuses a stale version (412), and reads old versions', async () => {
    const p = await s.client.create(
      new Patient({ name: [{ family: 'Kaya' }] }),
    );
    p.name![0].family = 'Kaya-Demir';
    const v2 = await s.client.update(p, { ifMatch: true });
    expect(v2.meta!.versionId).toBe('2');
    const stale = await rejects(s.client.update(p, { ifMatch: '1' }));
    expect(stale.status).toBe(412);
    expect(stale.message).toContain('version 1 is not the current one (2)');
    const v1 = await s.client.vread(Patient, p.id!, '1');
    expect(v1.name![0].family).toBe('Kaya');
    expect((await s.client.read(Patient, p.id!)).name![0].family).toBe(
      'Kaya-Demir',
    );
  });

  it('creates by update an id it does not have (201)', async () => {
    const r = await s.fetch(
      'Patient/given-id',
      put({ resourceType: 'Patient', id: 'given-id' }),
    );
    expect(r.status).toBe(201);
    expect(r.headers.get('Location')).toBe(
      `${s.base}/Patient/given-id/_history/1`,
    );
    const again = await s.fetch(
      'Patient/given-id',
      put({ resourceType: 'Patient', id: 'given-id', active: false }),
    );
    expect(again.status).toBe(200);
    expect(again.headers.get('ETag')).toBe('W/"2"');
  });

  it('deletes: read answers 410, a second delete 204, an update creates it again', async () => {
    const p = await s.client.create(new Patient({ active: true }));
    expect(
      (await s.fetch(`Patient/${p.id}`, { method: 'DELETE' })).status,
    ).toBe(204);
    expect(await outcome(await s.fetch(`Patient/${p.id}`))).toBe(
      `410 Patient/${p.id} was deleted`,
    );
    expect(
      (await s.fetch(`Patient/${p.id}`, { method: 'DELETE' })).status,
    ).toBe(204);
    const r = await s.fetch(
      `Patient/${p.id}`,
      put({ resourceType: 'Patient', id: p.id }),
    );
    expect(r.status).toBe(201);
    expect(r.headers.get('ETag')).toBe('W/"3"');
  });

  it('gives the history of an instance, newest first, with deletes', async () => {
    const p = await s.client.create(new Patient({ active: true }));
    await s.client.update(Object.assign(p, { active: false }));
    await s.client.delete(Patient, p.id!);
    const bundle = await (await s.fetch(`Patient/${p.id}/_history`)).json();
    expect(bundle).toMatchObject({
      resourceType: 'Bundle',
      type: 'history',
      total: 3,
    });
    expect(
      bundle.entry.map((e: any) => [
        e.request.method,
        e.response.status,
        e.response.etag,
      ]),
    ).toEqual([
      ['DELETE', '204 No Content', 'W/"3"'],
      ['PUT', '200 OK', 'W/"2"'],
      ['POST', '201 Created', 'W/"1"'],
    ]);
    expect(bundle.entry[0].resource).toBeUndefined();
    expect(bundle.entry[1].resource).toMatchObject({
      active: false,
      meta: { versionId: '2' },
    });
    expect(bundle.entry[2].request.url).toBe('Patient');
    expect(bundle.entry[1].fullUrl).toBe(`${s.base}/Patient/${p.id}`);
    expect(fhir.validate(bundle).valid).toBe(true);
  });

  it('pages a history with _count, and filters it with _since', async () => {
    const before = new Date().toISOString();
    await new Promise(r => setTimeout(r, 5));
    for (let i = 0; i < 3; i++)
      await s.client.create(
        new Observation({ status: 'final', code: { text: `o${i}` } }),
      );
    const first = await (
      await s.fetch(`Observation/_history?_since=${before}&_count=2`)
    ).json();
    expect(first.total).toBe(3);
    expect(first.entry).toHaveLength(2);
    expect(first.entry[0].resource.code.text).toBe('o2');
    const next = first.link.find((l: any) => l.relation === 'next').url;
    expect(next).toBe(
      `${s.base}/Observation/_history?_since=${encodeURIComponent(before)}&_count=2&_offset=2`,
    );
    const second = await (await fetch(next)).json();
    expect(second.entry.map((e: any) => e.resource.code.text)).toEqual(['o0']);
    expect(second.link.map((l: any) => l.relation)).toEqual([
      'self',
      'previous',
    ]);
    // through the client, which follows next
    const all = await (
      await s.client.history(Observation, undefined, {
        _since: before,
        _count: 2,
      })
    ).all();
    expect(all.map(o => o.code.text)).toEqual(['o2', 'o1', 'o0']);
  });

  it('gives the history of the server, every type', async () => {
    const bundle = await (await s.fetch('_history?_count=500')).json();
    const types = new Set(
      bundle.entry.map((e: any) => e.fullUrl.split('/').at(-2)),
    );
    expect([...types].sort()).toEqual(['Observation', 'Patient']);
  });

  it('answers Prefer: return=minimal and return=OperationOutcome', async () => {
    const minimal = await s.fetch(
      'Patient',
      post({ resourceType: 'Patient' }, { Prefer: 'return=minimal' }),
    );
    expect(minimal.status).toBe(201);
    expect(await minimal.text()).toBe('');
    expect(minimal.headers.get('Location')).toMatch(
      /\/Patient\/[0-9a-f-]+\/_history\/1$/,
    );
    const oo = await s.fetch(
      'Patient',
      post({ resourceType: 'Patient' }, { Prefer: 'return=OperationOutcome' }),
    );
    expect((await oo.json()).issue[0].diagnostics).toMatch(
      /^Patient\/.+ created$/,
    );
  });

  it('refuses an invalid resource with 422 and its issues', async () => {
    const r = await s.fetch(
      'Patient',
      post({
        resourceType: 'Patient',
        gender: 'unknown-value',
        birthDate: 'not a date',
      }),
    );
    expect(r.status).toBe(422);
    const issues = (await r.json()).issue;
    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues.map((i: any) => i.expression?.[0])).toEqual(
      expect.arrayContaining(['Patient.gender', 'Patient.birthDate']),
    );
  });

  it('refuses what is not a FHIR interaction, with the status the specification gives', async () => {
    const answers = [
      await s.fetch('Nope/1'),
      await s.fetch('Patient/bad id!'),
      await s.fetch('Patient/1', { method: 'POST' }),
      await s.fetch('Patient/1/$everything'),
      await s.fetch('Patient', post('not json')),
      await s.fetch('Patient', post({ resourceType: 'Observation' })),
      await s.fetch('Patient/a', put({ resourceType: 'Patient', id: 'b' })),
      await s.fetch('Patient/a', put({ resourceType: 'Patient' })),
      await s.fetch(
        'Patient',
        post(
          { resourceType: 'Patient' },
          { 'Content-Type': 'application/fhir+xml' },
        ),
      ),
      await s.fetch('Patient/1', {
        headers: { Accept: 'application/fhir+xml' },
      }),
      await s.fetch('Patient/1?_format=xml'),
      await s.fetch(
        'Patient/1',
        put({ resourceType: 'Patient', id: '1' }, { 'If-Match': 'nonsense' }),
      ),
      await s.fetch('Patient/no-such-id'),
      await s.fetch('Patient', { method: 'DELETE' }),
    ];
    expect(await Promise.all(answers.map(outcome))).toEqual([
      '404 Resource type Nope is not served',
      '400 "bad id!" is not a valid id',
      '405 POST is not supported on Patient/1',
      '404 Unknown operation $everything',
      '400 The body is not JSON',
      '400 The body is a Observation, not a Patient',
      "400 The Patient's id b is not the id of the URL, a",
      '400 The Patient has no id; it must be a',
      '415 A resource is sent as application/fhir+json, not application/fhir+xml',
      '406 Accept: application/fhir+xml: this server answers JSON only',
      '406 _format=xml: this server answers JSON only',
      '400 If-Match: "nonsense" is not a version (W/"3")',
      '404 Patient/no-such-id is not known',
      '405 DELETE is not supported on Patient',
    ]);
    // outside the base path
    expect(
      (await fetch(s.base.replace('/fhir', '/other/Patient/1'))).status,
    ).toBe(404);
  });

  it('describes itself in a valid CapabilityStatement', async () => {
    const cs = await s.client.capabilities();
    expect(cs).toMatchObject({
      resourceType: 'CapabilityStatement',
      fhirVersion: '4.0.1',
      kind: 'instance',
      format: ['json'],
    });
    const patient = cs.rest[0].resource.find((r: any) => r.type === 'Patient');
    expect(patient).toMatchObject({
      versioning: 'versioned-update',
      readHistory: true,
      updateCreate: true,
    });
    expect(patient.interaction.map((i: any) => i.code)).toEqual([
      'read',
      'vread',
      'create',
      'update',
      'patch',
      'delete',
      'history-instance',
      'history-type',
      'search-type',
    ]);
    expect(cs.rest[0].interaction).toEqual([
      { code: 'batch' },
      { code: 'transaction' },
      { code: 'history-system' },
    ]);
    expect(cs.rest[0].resource).toHaveLength(r4Model.resourceTypes().length);
    expect(cs.implementation.url).toBe(s.base);
    expect(fhir.validate(cs).valid).toBe(true);
  });
});

/**
 * A facade over a table of another shape, as a hospital information system
 * keeps its patients: read and update, no versions, no history
 */
class HbysPatients implements FhirStore {
  readonly rows = new Map<
    string,
    { tckn: string; ad: string; soyad: string; dogum: string }
  >([
    [
      '10000000146',
      { tckn: '10000000146', ad: 'Ayşe', soyad: 'Yılmaz', dogum: '1990-01-01' },
    ],
  ]);
  broken = false;

  capabilities(type: string): StoreCapabilities | undefined {
    return type === 'Patient'
      ? { interactions: ['read', 'update'], versions: 'none' }
      : undefined;
  }

  async read(type: string, id: string): Promise<StoredResource | undefined> {
    const row = this.rows.get(id);
    if (!row) return;
    return {
      type,
      id,
      resource: {
        resourceType: 'Patient',
        id,
        identifier: [
          { system: 'urn:oid:2.16.840.1.113883.3.9900.1', value: row.tckn },
        ],
        name: [{ family: row.soyad, given: [row.ad] }],
        birthDate: this.broken ? 'yesterday' : row.dogum,
      },
    };
  }

  async update(
    type: string,
    id: string,
    resource: Record<string, any>,
  ): Promise<StoredVersion | undefined> {
    if (!this.rows.has(id)) return;
    const name = resource.name?.[0];
    if (!name?.family || !name.given?.[0] || !resource.birthDate)
      throw new FhirServerError(
        400,
        'The table needs a family name, a given name and a birth date',
        'required',
      );
    this.rows.set(id, {
      tckn: id,
      ad: name.given[0],
      soyad: name.family,
      dogum: resource.birthDate,
    });
    return { ...(await this.read(type, id))!, method: 'PUT' };
  }
}

describe('FhirServer with a store per type: a facade over an existing database', () => {
  let s: Running;
  const hbys = new HbysPatients();
  before(
    async () =>
      (s = await start({
        stores: { Patient: hbys },
        resources: ['Patient', 'Observation'],
      })),
  );
  after(() => s.stop());

  it('reads a row of the table as a Patient, without ETag', async () => {
    const r = await s.fetch('Patient/10000000146');
    expect(r.status).toBe(200);
    expect(r.headers.get('ETag')).toBeNull();
    const p = await s.client.read(Patient, '10000000146');
    expect(p.name![0].given).toEqual(['Ayşe']);
  });

  it('writes an update to the table, and refuses If-Match (412) and what it cannot keep (400)', async () => {
    const p = await s.client.read(Patient, '10000000146');
    p.name![0].family = 'Kaya';
    const updated = await s.client.update(p);
    expect(updated.name![0].family).toBe('Kaya');
    expect(hbys.rows.get('10000000146')!.soyad).toBe('Kaya');
    expect((await rejects(s.client.update(p, { ifMatch: '1' }))).status).toBe(
      412,
    );
    const noBirth = await s.fetch(
      'Patient/10000000146',
      put({
        resourceType: 'Patient',
        id: '10000000146',
        name: [{ family: 'K', given: ['A'] }],
      }),
    );
    expect(await outcome(noBirth)).toBe(
      '400 The table needs a family name, a given name and a birth date',
    );
  });

  it('answers 405 for what the store does not declare, and serves the other types from the default store', async () => {
    expect(
      await outcome(
        await s.fetch('Patient', post({ resourceType: 'Patient' })),
      ),
    ).toBe('405 create is not supported for Patient');
    expect(await outcome(await s.fetch('Patient/10000000146/_history'))).toBe(
      '405 history is not supported for Patient',
    );
    expect(
      await outcome(
        await s.fetch(
          'Patient/x',
          put({
            resourceType: 'Patient',
            id: 'x',
            name: [{ family: 'K', given: ['A'] }],
            birthDate: '2000-01-01',
          }),
        ),
      ),
    ).toBe(
      '405 Patient/x does not exist, and the server does not create resources by update',
    );
    expect(await outcome(await s.fetch('_history'))).toBe(
      '405 History of the whole server is not supported: its types are in different stores',
    );
    expect(await outcome(await s.fetch('Encounter/1'))).toBe(
      '404 Resource type Encounter is not served',
    );
    const o = await s.client.create(
      new Observation({ status: 'final', code: { text: 'x' } }),
    );
    expect(o.meta!.versionId).toBe('1');
  });

  it('says in the CapabilityStatement what each store declares', async () => {
    const cs = await s.client.capabilities();
    const [patient, observation] = cs.rest[0].resource;
    expect(patient).toMatchObject({
      type: 'Patient',
      versioning: 'no-version',
      readHistory: false,
      updateCreate: false,
    });
    expect(patient.interaction.map((i: any) => i.code)).toEqual([
      'read',
      'update',
      'patch',
    ]);
    expect(observation).toMatchObject({
      type: 'Observation',
      versioning: 'versioned-update',
    });
    expect(cs.rest[0].interaction).toEqual([{ code: 'batch' }]);
  });

  it('answers 500 when the store gives what the model cannot read, and tells onError nothing else', async () => {
    hbys.broken = true;
    try {
      expect(await outcome(await s.fetch('Patient/10000000146'))).toMatch(
        /^500 The store gave a Patient\/10000000146 the model does not read: /,
      );
    } finally {
      hbys.broken = false;
    }
  });
});

describe('FhirServer: setup and interceptors', () => {
  it('refuses a type that is not a resource, or that no store serves', () => {
    expect(
      () =>
        new FhirServer({ fhir, store: new MemoryStore(), resources: ['Nope'] }),
    ).toThrow('Nope is not a resource type of FHIR 4.0.1');
    expect(
      () =>
        new FhirServer({
          fhir,
          stores: { Patient: new HbysPatients() },
          resources: ['Patient', 'Observation'],
        }),
    ).toThrow('No store serves Observation');
    expect(
      () =>
        new FhirServer({ fhir, stores: { Observation: new HbysPatients() } }),
    ).toThrow('The store of Observation does not serve it');
    expect(
      () => new FhirServer({ fhir, store: new MemoryStore(), base: 'fhir' }),
    ).toThrow('base must be a path');
  });

  it('runs interceptors around each exchange, the first outermost', async () => {
    const order: string[] = [];
    const s = await start({
      interceptors: [
        async (request, next) => {
          order.push('outer');
          const response = await next(request);
          response.headers.set('X-Outer', '1');
          return response;
        },
        async (request, next) => {
          order.push('inner');
          if (request.headers.get('Authorization') !== 'Bearer ok')
            return new Response(null, { status: 401 });
          return next(request);
        },
      ],
    });
    try {
      const refused = await s.fetch('metadata');
      expect(refused.status).toBe(401);
      expect(refused.headers.get('X-Outer')).toBe('1');
      expect(order).toEqual(['outer', 'inner']);
      const ok = await s.fetch('metadata', {
        headers: { Authorization: 'Bearer ok' },
      });
      expect(ok.status).toBe(200);
    } finally {
      await s.stop();
    }
  });

  it('answers 500 for an error it did not expect, and gives it to onError', async () => {
    const errors: unknown[] = [];
    const failing: FhirStore = {
      capabilities: () => ({ interactions: ['read'], versions: 'none' }),
      read: async () => {
        throw new Error('connection refused');
      },
    };
    const server = new FhirServer({
      fhir,
      store: failing,
      resources: ['Patient'],
      onError: e => errors.push(e),
    });
    const r = await server.handle(new Request('http://localhost/Patient/1'));
    expect(await outcome(r)).toBe(
      '500 The server could not answer the request',
    );
    expect((errors[0] as Error).message).toBe('connection refused');
  });
});
