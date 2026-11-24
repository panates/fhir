import { FhirContext } from '@fhirjs/core';
import {
  Bundle,
  Observation,
  Organization,
  Parameters,
  Patient,
  r4Model,
} from '@fhirjs/r4';
import { expect } from 'expect';
import {
  bearerToken,
  FhirClient,
  FhirClientError,
  toSearchParams,
} from '../src/index.js';
import { TestFhirServer } from './_support/test-server.js';

describe('FhirClient', () => {
  const server = new TestFhirServer();
  const fhir = new FhirContext(r4Model);
  let client: FhirClient;

  before(async () => {
    client = new FhirClient({ baseUrl: await server.start(), fhir });
  });
  after(() => server.stop());
  beforeEach(() => server.reset());

  const rejects = async (p: Promise<unknown>): Promise<FhirClientError> => {
    try {
      await p;
    } catch (e) {
      if (e instanceof FhirClientError) return e;
      throw e;
    }
    throw new Error('Expected a FhirClientError');
  };

  describe('read and write', () => {
    it('reads a resource as an instance of its class, by class or by name', async () => {
      server.put({
        resourceType: 'Patient',
        id: 'p1',
        name: [{ family: 'Yılmaz' }],
        birthDate: '1980-02-03',
      });
      const p = await client.read(Patient, 'p1');
      expect(p).toBeInstanceOf(Patient);
      expect(p.name![0].family).toBe('Yılmaz');
      expect(p.meta!.versionId).toBe('1');
      expect(await client.read('Patient', 'p1')).toBeInstanceOf(Patient);
      const req = server.requests[0];
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/fhir/Patient/p1');
      expect(req.headers.accept).toBe('application/fhir+json');
    });

    it('creates: sends the resource with the codec, gives back what the server stored', async () => {
      const created = await client.create(
        new Patient({ active: true, name: [{ family: 'Kaya' }] }),
      );
      expect(created).toBeInstanceOf(Patient);
      expect(created.id).toBe('1');
      expect(created.meta!.versionId).toBe('1');
      const req = server.requests[0];
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/fhir/Patient');
      expect(req.headers['content-type']).toBe(
        'application/fhir+json; charset=utf-8',
      );
      expect(req.headers.prefer).toBe('return=representation');
      expect(JSON.parse(req.body)).toEqual({
        resourceType: 'Patient',
        active: true,
        name: [{ family: 'Kaya' }],
      });
    });

    it('reads the stored resource from the Location when the server answers without a body', async () => {
      server.minimal = true;
      const created = await client.create(new Patient({ active: true }));
      expect(created.id).toBe('1');
      expect(server.requests.map(r => `${r.method} ${r.url}`)).toEqual([
        'POST /fhir/Patient',
        'GET /fhir/Patient/1/_history/1',
      ]);
    });

    it('creates conditionally: If-None-Exist', async () => {
      server.put({
        resourceType: 'Patient',
        id: 'x',
        identifier: [{ value: '42' }],
      });
      const p = await client.create(
        new Patient({ identifier: [{ value: '42' }] }),
        { ifNoneExist: { identifier: '42' } },
      );
      expect(p.id).toBe('x');
      expect(server.requests[0].headers['if-none-exist']).toBe('identifier=42');
    });

    it('checks what it sends: an invalid resource does not leave', async () => {
      const bad = new Patient({ gender: 'femal' as any });
      await expect(client.create(bad)).rejects.toThrow(
        /"femal" is not in the value set/,
      );
      expect(server.requests).toHaveLength(0);
    });

    it('updates, with If-Match from meta.versionId; a stale version fails with 412', async () => {
      server.put({ resourceType: 'Patient', id: 'p1', active: false });
      const p = await client.read(Patient, 'p1');
      p.active = true;
      const updated = await client.update(p, { ifMatch: true });
      expect(updated.meta!.versionId).toBe('2');
      expect(server.requests[1].headers['if-match']).toBe('W/"1"');
      const e = await rejects(client.update(p, { ifMatch: true }));
      expect(e.status).toBe(412);
      expect(e.outcome!.resourceType).toBe('OperationOutcome');
      expect(e.diagnostics).toEqual(['version 2 is current, not W/"1"']);
    });

    it('reads a version (vread) and the history', async () => {
      server.put({ resourceType: 'Patient', id: 'p1', active: false });
      server.put({ resourceType: 'Patient', id: 'p1', active: true });
      expect((await client.vread(Patient, 'p1', '1')).active).toBe(false);
      const h = await client.history(Patient, 'p1');
      expect(h.resources.map(r => r.meta!.versionId)).toEqual(['2', '1']);
      expect(server.requests[1].url).toBe('/fhir/Patient/p1/_history');
    });

    it('patches with JSON Patch', async () => {
      server.put({ resourceType: 'Patient', id: 'p1', active: false });
      const p = await client.patch(Patient, 'p1', [
        { op: 'replace', path: '/active', value: true },
      ]);
      expect(p.active).toBe(true);
      expect(server.requests[0].headers['content-type']).toBe(
        'application/json-patch+json',
      );
    });

    it("deletes; reading then gives the server's 410 with its OperationOutcome", async () => {
      server.put({ resourceType: 'Patient', id: 'p1' });
      await client.delete(Patient, 'p1');
      const e = await rejects(client.read(Patient, 'p1'));
      expect(e.status).toBe(410);
      expect(e.message).toMatch(
        /GET http:\/\/127\.0\.0\.1:\d+\/fhir\/Patient\/p1: 410 Gone \(Patient\/p1 was deleted\)/,
      );
    });

    it('keeps the precision of decimals both ways', async () => {
      const obs = fhir.decode<Observation>(
        '{"resourceType":"Observation","status":"final","code":{"text":"x"},"valueQuantity":{"value":1.50,"unit":"mg"}}',
      );
      await client.create(obs);
      expect(server.requests[0].body).toContain('"value":1.50');
      // the test server parses what it stores: an answer written as text instead
      const text =
        '{"resourceType":"Observation","id":"o1","status":"final","code":{"text":"x"},"valueQuantity":{"value":1.50,"unit":"mg"}}';
      const c = new FhirClient({
        baseUrl: server.baseUrl,
        fhir,
        fetch: async () =>
          new Response(text, {
            headers: { 'Content-Type': 'application/fhir+json' },
          }),
      });
      expect(fhir.stringify(await c.read(Observation, 'o1'))).toContain(
        '"value":1.50',
      );
    });

    it('fails a read whose answer is another resource type', async () => {
      const c = new FhirClient({
        baseUrl: server.baseUrl,
        fhir,
        fetch: async () => Response.json({ resourceType: 'Patient', id: 'p1' }),
      });
      const e = await rejects(c.read(Organization, 'p1'));
      expect(e.message).toMatch(
        /a Organization expected, the server sent Patient/,
      );
    });
  });

  describe('search', () => {
    beforeEach(() => {
      server.put({ resourceType: 'Organization', id: 'o1', name: 'Hastane' });
      for (let i = 1; i <= 5; i++)
        server.put({
          resourceType: 'Patient',
          id: `p${i}`,
          name: [{ family: i % 2 ? 'Smith' : 'Jones' }],
          managingOrganization: { reference: 'Organization/o1' },
        });
    });

    it('gives the matches, the included resources and the total', async () => {
      const r = await client.search(Patient, {
        name: 'smith',
        _include: 'Patient:organization',
      });
      expect(r.resources.map(p => p.id)).toEqual(['p1', 'p3', 'p5']);
      expect(r.resources[0]).toBeInstanceOf(Patient);
      expect(r.included.map(o => o.id)).toEqual(['o1', 'o1', 'o1']);
      expect(r.included[0]).toBeInstanceOf(Organization);
      expect(r.total).toBe(3);
      expect(r.bundle).toBeInstanceOf(Bundle);
      expect(server.requests[0].url).toBe(
        '/fhir/Patient?name=smith&_include=Patient%3Aorganization',
      );
    });

    it('follows the next links: page by page, or all at once', async () => {
      const first = await client.search(Patient, { _count: 2 });
      expect(first.resources).toHaveLength(2);
      expect(first.nextUrl).toMatch(/_offset=2/);
      const pages: string[][] = [];
      for await (const page of first.pages())
        pages.push(page.resources.map(p => p.id!));
      expect(pages).toEqual([['p1', 'p2'], ['p3', 'p4'], ['p5']]);
      expect((await first.all()).map(p => p.id)).toEqual([
        'p1',
        'p2',
        'p3',
        'p4',
        'p5',
      ]);
      expect((await first.all(3)).map(p => p.id)).toEqual(['p1', 'p2', 'p3']);
    });

    it('does not follow a next link to another server (it would take the headers there)', async () => {
      const r = await client.search(Patient, { _count: 2 });
      r.bundle.link[0].url = 'https://elsewhere.example/fhir/Patient?_offset=2';
      await expect(r.next()).rejects.toThrow(
        'https://elsewhere.example/fhir/Patient?_offset=2 is not on the server',
      );
    });

    it('searches with POST _search, the parameters in a form body', async () => {
      const r = await client.search(
        Patient,
        { _id: 'p2,p4' },
        { method: 'POST' },
      );
      expect(r.resources.map(p => p.id)).toEqual(['p2', 'p4']);
      expect(server.requests[0].url).toBe('/fhir/Patient/_search');
      expect(server.requests[0].body).toBe('_id=p2%2Cp4');
    });

    it('writes parameters: a list repeats the parameter (AND), dates as instants, null left out', () => {
      expect(
        toSearchParams({
          birthdate: ['ge1970', 'lt1980'],
          'name:exact': 'Smith',
          _lastUpdated: new Date(Date.UTC(2026, 0, 2)),
          active: true,
          gender: undefined,
          family: null,
        }).toString(),
      ).toBe(
        'birthdate=ge1970&birthdate=lt1980&name%3Aexact=Smith&_lastUpdated=2026-01-02T00%3A00%3A00.000Z&active=true',
      );
    });
  });

  describe('server level', () => {
    it('reads the CapabilityStatement', async () => {
      const cs = await client.capabilities();
      expect(cs.resourceType).toBe('CapabilityStatement');
      expect(server.requests[0].url).toBe('/fhir/metadata');
    });

    it('runs operations: on an instance, with a Parameters input, with GET parameters, without an answer', async () => {
      server.put({ resourceType: 'Patient', id: 'p1' });
      const everything = await client.operation<Bundle>('$everything', {
        type: Patient,
        id: 'p1',
      });
      expect(everything).toBeInstanceOf(Bundle);
      expect(server.requests[0].url).toBe('/fhir/Patient/p1/$everything');

      const input = new Parameters({
        parameter: [{ name: 'a', valueString: 'b' }],
      });
      const echoed = await client.operation<Parameters>('echo', { input });
      expect(echoed).toBeInstanceOf(Parameters);
      expect(echoed!.parameter![0].valueString).toBe('b');

      const got = await client.operation<Parameters>('$echo', {
        params: { x: '1' },
      });
      expect(got!.parameter).toEqual([{ name: 'x', valueString: '1' }]);
      expect(server.requests[2].method).toBe('GET');

      expect(await client.operation('$nothing', { input })).toBeUndefined();
      expect(() => client.operation('$../x')).rejects.toThrow(
        'is not an operation name',
      );
    });

    it('sends a transaction Bundle and gives the response Bundle', async () => {
      const bundle = new Bundle({
        type: 'transaction',
        entry: [
          {
            resource: new Patient({ active: true }),
            request: { method: 'POST', url: 'Patient' },
          },
        ],
      });
      const r = await client.transaction<Bundle>(bundle);
      expect(r).toBeInstanceOf(Bundle);
      expect(r.type).toBe('transaction-response');
      expect(r.entry![0].resource).toBeInstanceOf(Patient);
      await expect(client.batch(bundle)).rejects.toThrow(
        "the Bundle's type is transaction, not batch",
      );
    });
  });

  describe('requests', () => {
    it('runs interceptors around each exchange, the first outermost', async () => {
      const seen: string[] = [];
      const c = new FhirClient({
        baseUrl: server.baseUrl,
        fhir,
        headers: { 'X-Tenant': 't1' },
        interceptors: [
          async (req, next) => {
            seen.push('outer');
            const h = new Headers(req.headers);
            h.set('Authorization', 'Bearer abc');
            const res = await next(new Request(req, { headers: h }));
            seen.push(`outer ${res.status}`);
            return res;
          },
          async (req, next) => {
            seen.push(`inner ${req.headers.get('Authorization')}`);
            return next(req);
          },
        ],
      });
      await c.capabilities();
      expect(seen).toEqual(['outer', 'inner Bearer abc', 'outer 200']);
      expect(server.requests[0].headers.authorization).toBe('Bearer abc');
      expect(server.requests[0].headers['x-tenant']).toBe('t1');
    });

    it('refuses ids and type names that would change the path', async () => {
      await expect(client.read(Patient, '../metadata')).rejects.toThrow(
        '"../metadata" is not a FHIR id',
      );
      await expect(client.read('Patient/x', '1')).rejects.toThrow(
        'is not a resource type',
      );
      expect(server.requests).toHaveLength(0);
    });

    it('gives an error that is not FHIR (an HTML page) with its status', async () => {
      const c = new FhirClient({
        baseUrl: server.baseUrl,
        fhir,
        fetch: async () =>
          new Response('<html>Bad gateway</html>', {
            status: 502,
            statusText: 'Bad Gateway',
          }),
      });
      const e = await rejects(c.capabilities());
      expect(e.status).toBe(502);
      expect(e.outcome).toBeUndefined();
    });

    it('decodes leniently when asked: elements the model does not know are kept', async () => {
      server.put({ resourceType: 'Patient', id: 'p1', futureElement: 'x' });
      await expect(client.read(Patient, 'p1')).rejects.toThrow(/futureElement/);
      const lenient = new FhirClient({
        baseUrl: server.baseUrl,
        fhir,
        decode: { unknownElements: 'keep' },
      });
      expect(((await lenient.read(Patient, 'p1')) as any).futureElement).toBe(
        'x',
      );
    });
  });

  describe('conditional interactions', () => {
    beforeEach(() => {
      server.put({
        resourceType: 'Patient',
        id: 'a',
        identifier: [{ value: '1' }],
        active: false,
      });
      server.put({
        resourceType: 'Patient',
        id: 'b',
        identifier: [{ value: '2' }],
        name: [{ family: 'Smith' }],
      });
      server.put({
        resourceType: 'Patient',
        id: 'c',
        identifier: [{ value: '3' }],
        name: [{ family: 'Smith' }],
      });
    });

    it('updates what a search finds, or creates it when it finds nothing', async () => {
      const p = await client.update(
        new Patient({ identifier: [{ value: '1' }], active: true }),
        { where: { identifier: '1' } },
      );
      expect(p.id).toBe('a');
      expect(p.meta!.versionId).toBe('2');
      expect(server.requests[0].url).toBe('/fhir/Patient?identifier=1');
      const created = await client.update(
        new Patient({ identifier: [{ value: '9' }] }),
        { where: { identifier: '9' } },
      );
      expect(created.meta!.versionId).toBe('1');
    });

    it('fails when the search finds more than one (412)', async () => {
      const e = await rejects(
        client.update(new Patient({ active: true }), {
          where: { name: 'smith' },
        }),
      );
      expect(e.status).toBe(412);
      expect(e.diagnostics).toEqual(['2 Patient resources match']);
    });

    it('patches and deletes by a search', async () => {
      const p = await client.patch(Patient, { identifier: '1' }, [
        { op: 'replace', path: '/active', value: true },
      ]);
      expect(p.id).toBe('a');
      expect(p.active).toBe(true);
      await client.delete(Patient, { identifier: '2' });
      expect(server.requests.at(-1)!.url).toBe('/fhir/Patient?identifier=2');
      await expect(client.read(Patient, 'b')).rejects.toThrow(/410/);
    });

    it('refuses a conditional interaction without search parameters (it would match every resource)', async () => {
      await expect(client.delete(Patient, {})).rejects.toThrow(
        'a conditional delete needs search parameters',
      );
      await expect(
        client.update(new Patient(), { where: { identifier: undefined } }),
      ).rejects.toThrow('a conditional update needs search parameters');
      expect(server.requests.filter(r => r.method !== 'GET')).toHaveLength(0);
    });
  });

  describe('partial resources', () => {
    beforeEach(() => {
      server.put({
        resourceType: 'Observation',
        id: 'o1',
        status: 'final',
        code: { text: 'x' },
        valueString: 'v',
      });
    });

    it('reads a part (_elements): without the required elements, tagged SUBSETTED', async () => {
      const o = await client.read(Observation, 'o1', {
        elements: ['valueString'],
      });
      expect(server.requests[0].url).toBe(
        '/fhir/Observation/o1?_elements=valueString',
      );
      expect(o).toBeInstanceOf(Observation);
      expect(o.valueString).toBe('v');
      expect(o.status).toBeUndefined(); // required, left out by the server
      expect(o.meta!.tag![0].code).toBe('SUBSETTED');
    });

    it('searches with _summary; a whole read of the same resource still needs its required elements', async () => {
      const r = await client.search(Observation, {}, { summary: 'true' });
      expect(server.requests[0].url).toBe('/fhir/Observation?_summary=true');
      expect(r.resources[0]).toBeInstanceOf(Observation);
      server.put({
        resourceType: 'Observation',
        id: 'o2',
        code: { text: 'no status' },
      });
      await expect(client.read(Observation, 'o2')).rejects.toThrow(
        /status is required/,
      );
    });

    it('does not update a resource read in part: it would erase what was left out', async () => {
      const o = await client.read(Observation, 'o1', {
        elements: ['valueString'],
      });
      await expect(client.update(o)).rejects.toThrow(
        'was read in part (SUBSETTED)',
      );
    });
  });

  describe('bearerToken()', () => {
    it('sends the token; on 401 gets a new one once and sends the request again, with its body', async () => {
      server.token = 'new';
      const asked: boolean[] = [];
      const c = new FhirClient({
        baseUrl: server.baseUrl,
        fhir,
        interceptors: [
          bearerToken(
            refresh => (asked.push(refresh), refresh ? 'new' : 'old'),
          ),
        ],
      });
      const created = await c.create(new Patient({ active: true }));
      expect(created.active).toBe(true);
      expect(asked).toEqual([false, true]);
      expect(
        server.requests.map(r => `${r.method} ${r.headers.authorization}`),
      ).toEqual(['POST Bearer old', 'POST Bearer new']);
      expect(JSON.parse(server.requests[1].body).active).toBe(true);
      await c.capabilities();
      expect(asked).toEqual([false, true]); // the new token is kept
    });

    it('refreshes once for requests refused together, and fails when the new token is refused too', async () => {
      server.token = 'new';
      let refreshes = 0;
      const c = new FhirClient({
        baseUrl: server.baseUrl,
        fhir,
        interceptors: [
          bearerToken(async refresh =>
            refresh ? (refreshes++, 'new') : 'old',
          ),
        ],
      });
      await Promise.all([c.capabilities(), c.capabilities(), c.capabilities()]);
      expect(refreshes).toBe(1);

      server.token = 'newer';
      const e = await rejects(
        new FhirClient({
          baseUrl: server.baseUrl,
          fhir,
          interceptors: [bearerToken(() => 'x')],
        }).capabilities(),
      );
      expect(e.status).toBe(401);
    });
  });
});
