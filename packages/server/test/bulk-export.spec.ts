/**
 * Bulk Data export: the kick-off, the status and its manifest, the files,
 * at the three levels; the refusals; the caller's scopes; a failure, a
 * cancellation, the files' expiry, a restart; files in a folder.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FhirContext } from '@fhirjs/core';
import { r4Model } from '@fhirjs/r4';
import { expect } from 'expect';
import {
  type BulkExportOptions,
  type ExportJob,
  type FhirAuthenticator,
  type FhirPrincipal,
  type FhirStore,
  FhirServer,
  FileExportStorage,
  MemoryExportJobStore,
  MemoryExportStorage,
  MemoryStore,
  SmartAuthorizer,
} from '../src/index.js';

const fhir = new FhirContext(r4Model);
const BASE = 'http://localhost/fhir';

/** The caller, from a test header: a subject, the scopes, the patient in context */
const fromHeader: FhirAuthenticator = {
  async authenticate(request) {
    const h = request.headers.get('X-Test-Principal');
    if (!h) return;
    const { subject, scopes, patient } = JSON.parse(h);
    const p: FhirPrincipal = {
      subject: subject ?? 'u',
      method: 'test',
      scopes: scopes.split(' '),
      claims: {},
    };
    if (patient) p.patient = patient;
    return p;
  },
};

const obs = (id: string, subject: string, extra: Record<string, any> = {}) => ({
  resourceType: 'Observation',
  id,
  status: 'final',
  code: { text: id },
  subject: { reference: `Patient/${subject}` },
  ...extra,
});

const RESOURCES = [
  { resourceType: 'Patient', id: 'p1' },
  { resourceType: 'Patient', id: 'p2' },
  { resourceType: 'Patient', id: 'p3' },
  obs('o1', 'p1'),
  obs('o2', 'p2'),
  obs('o3', 'p1'),
  // in p1's compartment by performer only
  obs('o4', 'p2', { performer: [{ reference: 'Patient/p1' }] }),
  // by subject and performer: once in a group's export
  obs('o5', 'p1', { performer: [{ reference: 'Patient/p1' }] }),
  {
    resourceType: 'Encounter',
    id: 'e1',
    status: 'finished',
    class: { code: 'AMB' },
    subject: { reference: 'Patient/p1' },
  },
  { resourceType: 'Medication', id: 'm1' },
  {
    resourceType: 'Group',
    id: 'g1',
    type: 'person',
    actual: true,
    member: [{ entity: { reference: 'Patient/p1' } }],
  },
];

const ALL = JSON.stringify({ scopes: 'system/*.cruds' });

async function setUp(
  options: Partial<BulkExportOptions> & {
    secure?: boolean;
    store?: FhirStore;
  } = {},
) {
  const { secure, store = new MemoryStore(), ...rest } = options;
  const storage = new MemoryExportStorage();
  const server = new FhirServer({
    fhir,
    store,
    base: '/fhir',
    bulkExport: { storage, fileSize: 3, pageSize: 2, ...rest },
    ...(secure && {
      security: {
        authenticators: [fromHeader],
        authorizer: new SmartAuthorizer({ fhir }),
      },
    }),
  });
  for (const r of RESOURCES) {
    const put = await server.handle(
      new Request(`${BASE}/${r.resourceType}/${r.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/fhir+json',
          'X-Test-Principal': ALL,
        },
        body: JSON.stringify(r),
      }),
    );
    expect([r.id, put.status]).toEqual([r.id, 201]);
  }
  const send = (
    method: string,
    url: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ) =>
    server.handle(
      new Request(url.startsWith('http') ? url : `${BASE}/${url}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const async = { Prefer: 'respond-async', Accept: 'application/fhir+json' };
  /** A kick-off; its status URL */
  const kickOff = async (
    path: string,
    headers: Record<string, string> = {},
  ) => {
    const r = await send('GET', path, { ...async, ...headers });
    expect([r.status, await r.text()]).toEqual([202, '']);
    return r.headers.get('Content-Location')!;
  };
  /** An export run to its end: its manifest, and its files' resources by url */
  const run = async (path: string, headers: Record<string, string> = {}) => {
    const status = await kickOff(path, headers);
    await server.bulkExport!.idle();
    const r = await send('GET', status, headers);
    expect(r.status).toBe(200);
    const manifest = await r.json();
    const files: Record<string, any[]> = {};
    for (const f of [...manifest.output, ...manifest.error]) {
      const file = await send('GET', f.url, {
        ...headers,
        Accept: 'application/fhir+ndjson',
      });
      expect(file.headers.get('Content-Type')).toBe('application/fhir+ndjson');
      const text = await file.text();
      expect(text.endsWith('\n')).toBe(true);
      files[f.url] = text
        .trimEnd()
        .split('\n')
        .map(l => JSON.parse(l));
    }
    return { status, manifest, files, headers: r.headers };
  };
  /** The ids exported, by type */
  const ids = (files: Record<string, any[]>) => {
    const by: Record<string, string[]> = {};
    for (const list of Object.values(files))
      for (const r of list)
        if (r.resourceType !== 'OperationOutcome')
          (by[r.resourceType] ??= []).push(r.id);
    for (const k of Object.keys(by)) by[k].sort();
    return by;
  };
  return { server, storage, send, kickOff, run, ids };
}

const refusal = async (r: Response) =>
  `${r.status} ${(await r.json()).issue[0].diagnostics}`;

describe('Bulk Data export', () => {
  it('exports the whole server: 202, the status, the manifest and NDJSON files', async () => {
    const { server, send, run, ids } = await setUp();
    const before = new Date().toISOString();
    const { status, manifest, files, headers } = await run('$export');
    expect(status).toMatch(
      /^http:\/\/localhost\/fhir\/\$export-status\/[0-9a-f-]{36}$/,
    );
    expect(manifest.request).toBe(`${BASE}/$export`);
    expect(manifest.transactionTime >= before).toBe(true);
    expect(manifest.requiresAccessToken).toBe(false);
    expect(manifest.error).toEqual([]);
    // files of three resources at most, in order
    const id = status.split('/').pop();
    expect(
      manifest.output.map((f: any) => [
        f.type,
        f.url.split('/').pop(),
        f.count,
      ]),
    ).toEqual([
      ['Encounter', 'Encounter-1.ndjson', 1],
      ['Group', 'Group-1.ndjson', 1],
      ['Medication', 'Medication-1.ndjson', 1],
      ['Observation', 'Observation-1.ndjson', 3],
      ['Observation', 'Observation-2.ndjson', 2],
      ['Patient', 'Patient-1.ndjson', 3],
    ]);
    expect(manifest.output[0].url).toBe(
      `${BASE}/$export-file/${id}/Encounter-1.ndjson`,
    );
    expect(ids(files)).toEqual({
      Encounter: ['e1'],
      Group: ['g1'],
      Medication: ['m1'],
      Observation: ['o1', 'o2', 'o3', 'o4', 'o5'],
      Patient: ['p1', 'p2', 'p3'],
    });
    // each line a resource as the server writes it
    expect(Object.values(files)[0][0]).toMatchObject({
      resourceType: 'Encounter',
      id: 'e1',
      meta: { versionId: '1' },
    });
    expect(Date.parse(headers.get('Expires')!)).toBeGreaterThan(Date.now());

    // the CapabilityStatement says so
    const cs = await (await send('GET', 'metadata')).json();
    expect(cs.instantiates).toEqual([
      'http://hl7.org/fhir/uv/bulkdata/CapabilityStatement/bulk-data',
    ]);
    expect(cs.rest[0].operation).toEqual([
      {
        name: 'export',
        definition:
          'http://hl7.org/fhir/uv/bulkdata/OperationDefinition/export',
      },
    ]);
    const op = (type: string) =>
      cs.rest[0].resource
        .find((r: any) => r.type === type)
        .operation.map((o: any) => o.definition.split('/').pop());
    expect([op('Patient'), op('Group'), op('Observation')]).toEqual([
      ['Resource-validate', 'patient-export'],
      ['Resource-validate', 'group-export'],
      ['Resource-validate'],
    ]);
    // without bulkExport, no such operation
    const plain = new FhirServer({ fhir, store: new MemoryStore() });
    const r = await plain.handle(new Request('http://localhost/$export'));
    expect(await refusal(r)).toBe('404 Unknown operation $export');
    void server;
  });

  it('exports the types asked, and what changed since an instant', async () => {
    const { send, run, ids } = await setUp();
    expect(ids((await run('$export?_type=Patient,Encounter')).files)).toEqual({
      Encounter: ['e1'],
      Patient: ['p1', 'p2'].concat('p3'),
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    const since = new Date().toISOString();
    await send(
      'PUT',
      'Observation/o2',
      { 'Content-Type': 'application/fhir+json' },
      obs('o2', 'p3'),
    );
    const r = await run(
      `$export?_type=Observation,Patient&_since=${encodeURIComponent(since)}`,
    );
    expect(ids(r.files)).toEqual({ Observation: ['o2'] });
    expect(r.manifest.output).toEqual([
      expect.objectContaining({ type: 'Observation', count: 1 }),
    ]);
    // a POST with Parameters
    const post = await send(
      'POST',
      '$export',
      {
        Prefer: 'respond-async',
        'Content-Type': 'application/fhir+json',
      },
      {
        resourceType: 'Parameters',
        parameter: [
          { name: '_type', valueString: 'Medication' },
          { name: '_outputFormat', valueString: 'application/fhir+ndjson' },
        ],
      },
    );
    expect(post.status).toBe(202);
  });

  it('exports the patients: the types of the Patient compartment', async () => {
    const { run, ids } = await setUp();
    expect(ids((await run('Patient/$export')).files)).toEqual({
      Encounter: ['e1'],
      Group: ['g1'],
      Observation: ['o1', 'o2', 'o3', 'o4', 'o5'],
      Patient: ['p1', 'p2', 'p3'],
    });
  });

  it('exports a group: its patients and the resources of their compartments, each once', async () => {
    const { send, run, ids } = await setUp();
    const r = await run('Group/g1/$export');
    // the Group itself is in its patient's compartment, by member
    expect(ids(r.files)).toEqual({
      Encounter: ['e1'],
      Group: ['g1'],
      Observation: ['o1', 'o3', 'o4', 'o5'],
      Patient: ['p1'],
    });
    expect(r.manifest.error).toEqual([]);
    expect(
      await refusal(
        await send('GET', 'Group/nope/$export', { Prefer: 'respond-async' }),
      ),
    ).toBe('404 Group/nope is not known');

    // members of the application's own (a facade without Group)
    const own = await setUp({
      groupMembers: async id => (id === 'ward-3' ? ['p2', 'p3'] : undefined),
    });
    expect(
      ids(
        (await own.run('Group/ward-3/$export?_type=Patient,Observation')).files,
      ),
    ).toEqual({ Observation: ['o2', 'o4'], Patient: ['p2', 'p3'] });
  });

  it('refuses what it does not do', async () => {
    const { send } = await setUp();
    const go = (path: string, prefer = 'respond-async') =>
      send('GET', path, { Prefer: prefer }).then(refusal);
    expect([
      await go('$export', ''),
      await go('$export?_typeFilter=Observation%3Fstatus%3Dfinal'),
      await go('$export?_outputFormat=text/csv'),
      await go('$export?_since=yesterday'),
      await go('$export?_type=Nope'),
      await go('Patient/$export?_type=Medication'),
      await (
        await send('PUT', '$export')
      )
        .json()
        .then(b => b.issue[0].diagnostics),
      await go('$export-status/nope'),
      await go('$export-file/nope/Patient-1.ndjson'),
    ]).toEqual([
      '400 $export is asynchronous: it needs Prefer: respond-async',
      '400 $export: _typeFilter is not supported',
      '400 $export: _outputFormat text/csv is not supported; application/fhir+ndjson is',
      '400 $export: _since yesterday is not an instant',
      '400 $export: Nope is not served, or not searched',
      '400 $export: Medication is not in the Patient compartment, or not searched',
      'PUT is not supported on $export',
      '404 No export nope',
      '404 No export nope',
    ]);
    // handling=lenient: what is not supported is left out
    const r = await send('GET', '$export?_typeFilter=x&_type=Patient', {
      Prefer: 'respond-async, handling=lenient',
    });
    expect(r.status).toBe(202);
  });

  it("follows the caller's scopes; only the caller sees its status and files", async () => {
    const { send, kickOff, run, ids, server } = await setUp({ secure: true });
    const system = {
      'X-Test-Principal': JSON.stringify({ scopes: 'system/*.rs' }),
    };
    const all = await run('$export', system);
    expect(all.manifest.requiresAccessToken).toBe(true);
    expect(ids(all.files).Observation).toEqual(['o1', 'o2', 'o3', 'o4', 'o5']);

    // patient/ scopes: the patient's compartment as the authorizer restricts a
    // search (by patient or subject: o4, p1's by performer only, is not
    // in), the other types whole
    const p1 = {
      'X-Test-Principal': JSON.stringify({
        subject: 'p',
        scopes: 'patient/*.rs',
        patient: 'p1',
      }),
    };
    expect(ids((await run('$export', p1)).files)).toEqual({
      Encounter: ['e1'],
      Group: ['g1'],
      Medication: ['m1'],
      Observation: ['o1', 'o3', 'o5'],
      Patient: ['p1'],
    });
    // a type the scopes do not grant: refused when asked, left out otherwise
    const obsOnly = {
      'X-Test-Principal': JSON.stringify({ scopes: 'system/Observation.rs' }),
    };
    expect(
      await refusal(
        await send('GET', '$export?_type=Patient', {
          Prefer: 'respond-async',
          ...obsOnly,
        }),
      ),
    ).toBe('403 The scopes do not grant s on Patient');
    const some = await run('$export', obsOnly);
    expect(Object.keys(ids(some.files))).toEqual(['Observation']);
    expect(some.manifest.error.length).toBe(1);

    // another caller: as if there were no such export
    const status = await kickOff('$export?_type=Patient', system);
    await server.bulkExport!.idle();
    const other = {
      'X-Test-Principal': JSON.stringify({
        subject: 'x',
        scopes: 'system/*.rs',
      }),
    };
    const manifest = await (await send('GET', status, system)).json();
    expect([
      (await send('GET', status, other)).status,
      (await send('GET', manifest.output[0].url, other)).status,
      (await send('DELETE', status, other)).status,
      (await send('GET', status)).status,
      (await send('GET', manifest.output[0].url)).status,
      (await send('GET', manifest.output[0].url, system)).status,
    ]).toEqual([404, 404, 404, 401, 401, 200]);
  });

  it('answers 202 with its progress while it runs; cancelled, its files go', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const inner = new MemoryStore();
    const store: FhirStore = Object.create(inner);
    store.search = async (type, query) => {
      if (type === 'Observation') await gate;
      return inner.search(type, query);
    };
    const { send, kickOff, server, storage } = await setUp({
      store,
      retryAfter: 2,
    });
    const status = await kickOff('$export?_type=Patient,Observation');
    await new Promise(resolve => setTimeout(resolve, 20));
    const r = await send('GET', status);
    expect([
      r.status,
      r.headers.get('X-Progress'),
      r.headers.get('Retry-After'),
    ]).toEqual([202, 'Observation (2 of 2)', '2']);
    expect(storage.jobs.length).toBe(1);
    expect((await send('DELETE', status)).status).toBe(202);
    release();
    await server.bulkExport!.idle();
    expect((await send('GET', status)).status).toBe(404);
    expect(storage.jobs).toEqual([]);

    // a finished export deleted: its files too
    const done = await kickOff('$export?_type=Patient');
    await server.bulkExport!.idle();
    expect(storage.jobs.length).toBe(1);
    expect((await send('DELETE', done)).status).toBe(202);
    expect([(await send('GET', done)).status, storage.jobs]).toEqual([404, []]);
  });

  it('fails with the reason; keeps files for `keep`; fails an export a stopped process ran', async () => {
    const inner = new MemoryStore();
    const store: FhirStore = Object.create(inner);
    store.search = async (type, query) => {
      if (type === 'Encounter') throw new Error('the database is down');
      return inner.search(type, query);
    };
    const jobs = new MemoryExportJobStore();
    const { send, kickOff, server } = await setUp({ store, jobs, keep: 50 });
    const failed = await kickOff('$export?_type=Patient,Encounter');
    await server.bulkExport!.idle();
    expect(await refusal(await send('GET', failed))).toBe(
      '500 The export failed: an error of the server',
    );
    // kept for `keep`, then gone
    const ok = await kickOff('$export?_type=Patient');
    await server.bulkExport!.idle();
    expect((await send('GET', ok)).status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect([
      (await send('GET', ok)).status,
      (await jobs.list()).length,
    ]).toEqual([404, 0]);

    // an export another process was running when it stopped
    const job: ExportJob = {
      id: 'left-over',
      status: 'in-progress',
      request: `${BASE}/$export`,
      transactionTime: new Date().toISOString(),
      level: 'system',
      types: ['Patient'],
      output: [],
      error: [],
    };
    await jobs.put(job);
    expect(await refusal(await send('GET', '$export-status/left-over'))).toBe(
      '500 The export failed: The server stopped while the export ran',
    );
  });

  it('writes its files to a folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fhir-export-'));
    try {
      const storage = new FileExportStorage(dir);
      const w = await storage.create('job-1', 'Patient-1.ndjson');
      await w.write('{"resourceType":"Patient","id":"a"}');
      await w.write('{"resourceType":"Patient","id":"b"}');
      await w.close();
      const body = await storage.read('job-1', 'Patient-1.ndjson');
      expect(await new Response(body).text()).toBe(
        '{"resourceType":"Patient","id":"a"}\n{"resourceType":"Patient","id":"b"}\n',
      );
      expect(await storage.read('job-1', 'nope.ndjson')).toBeUndefined();
      await expect(storage.read('job-1', '..')).rejects.toThrow('No file ..');
      await storage.delete('job-1');
      expect(await readdir(dir)).toEqual([]);

      // through a server
      const { run, ids } = await setUp({ storage: new FileExportStorage(dir) });
      expect(ids((await run('$export?_type=Patient')).files)).toEqual({
        Patient: ['p1', 'p2', 'p3'],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
