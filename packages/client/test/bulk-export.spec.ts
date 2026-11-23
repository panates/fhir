/**
 * The client's Bulk Data export, against @fhirjs/server's $export: the
 * kick-off, the wait as Retry-After says, the files as resources; a group,
 * the caller's token, a signed URL read without it, a cancel; a status
 * asked too often (429), an abort, lines split across chunks.
 */
import { FhirContext } from '@fhirjs/core';
import { r4Model } from '@fhirjs/r4';
import {
  type ExportStorage,
  type FhirAuthenticator,
  type FhirStore,
  FhirServer,
  MemoryExportStorage,
  MemoryStore,
  SmartAuthorizer,
} from '@fhirjs/server';
import { expect } from 'expect';
import {
  FhirClient,
  FhirClientError,
  type FhirBulkManifest,
  bearerToken,
} from '../src/index.js';

const fhir = new FhirContext(r4Model);
const BASE = 'http://localhost/fhir';

const obs = (id: string, subject: string) => ({
  resourceType: 'Observation',
  id,
  status: 'final',
  code: { text: id },
  subject: { reference: `Patient/${subject}` },
});
const RESOURCES = [
  { resourceType: 'Patient', id: 'p1' },
  { resourceType: 'Patient', id: 'p2' },
  { resourceType: 'Patient', id: 'p3' },
  obs('o1', 'p1'),
  obs('o2', 'p2'),
  obs('o3', 'p1'),
  { resourceType: 'Medication', id: 'm1' },
  {
    resourceType: 'Group',
    id: 'g1',
    type: 'person',
    actual: true,
    member: [{ entity: { reference: 'Patient/p1' } }],
  },
];

/** A token's scopes: 'token-system' is system/*.rs, 'token-obs' system/Observation.rs */
const fromToken: FhirAuthenticator = {
  async authenticate(request) {
    const m = /^Bearer token-(\w+)$/.exec(
      request.headers.get('Authorization') ?? '',
    );
    if (!m) return;
    return {
      subject: m[1],
      method: 'test',
      scopes: [m[1] === 'obs' ? 'system/Observation.rs' : 'system/*.cruds'],
      claims: {},
    };
  },
  challenge: 'Bearer',
};

/** A server, filled, and the requests it was sent */
async function serverWith(
  options: {
    secure?: boolean;
    store?: FhirStore;
    storage?: ExportStorage;
    maxExports?: number;
    /** Provenance served too */
    provenance?: boolean;
  } = {},
) {
  const server = new FhirServer({
    fhir,
    store: options.store ?? new MemoryStore(),
    resources: [
      'Patient',
      'Observation',
      'Medication',
      'Group',
      ...(options.provenance ? ['Provenance'] : []),
    ],
    base: '/fhir',
    bulkExport: {
      storage: options.storage ?? new MemoryExportStorage(),
      fileSize: 2,
      retryAfter: 0,
      maxExports: options.maxExports,
    },
    ...(options.secure && {
      security: {
        authenticators: [fromToken],
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
          Authorization: 'Bearer token-system',
        },
        body: JSON.stringify(r),
      }),
    );
    expect(put.status).toBe(201);
  }
  const sent: Request[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = new Request(input, init);
    sent.push(r.clone());
    return server.handle(r);
  }) as typeof globalThis.fetch;
  return { server, sent, fetch };
}

const client = (fetch: typeof globalThis.fetch, token?: string) =>
  new FhirClient({
    baseUrl: BASE,
    fhir,
    fetch,
    interceptors: token ? [bearerToken(() => token)] : [],
  });

const idsByType = (resources: any[]) => {
  const by: Record<string, string[]> = {};
  for (const r of resources) (by[r.resourceType] ??= []).push(r.id);
  for (const k of Object.keys(by)) by[k].sort();
  return by;
};

const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe('FhirClient.bulkExport()', () => {
  it('starts an export, waits for its manifest and reads its files as resources', async () => {
    const { fetch, sent } = await serverWith();
    const c = client(fetch);
    const job = await c.bulkExport({ types: ['Patient', 'Observation'] });
    expect(job.statusUrl).toMatch(
      /^http:\/\/localhost\/fhir\/\$export-status\//,
    );
    const kickOff = sent.find(r => r.url.includes('/$export?'))!;
    expect([kickOff.url, kickOff.headers.get('Prefer')]).toEqual([
      `${BASE}/$export?_type=Patient%2CObservation`,
      'respond-async',
    ]);
    // the server's Retry-After (0) is followed, not the interval
    const manifest = await job.wait({
      interval: 120_000,
      maxInterval: 120_000,
    });
    // in the order asked, files of two
    expect(manifest.output.map(f => [f.type, f.count])).toEqual([
      ['Patient', 2],
      ['Patient', 1],
      ['Observation', 2],
      ['Observation', 1],
    ]);
    const resources = await collect(job.resources(manifest));
    // decoded by the codec: instances of the model's classes
    expect(resources[0].constructor.name).toBe('Patient');
    expect(idsByType(resources)).toEqual({
      Observation: ['o1', 'o2', 'o3'],
      Patient: ['p1', 'p2', 'p3'],
    });
    expect(
      (await collect(job.resources(manifest, { types: ['Patient'] }))).length,
    ).toBe(3);
    // the files asked with NDJSON
    expect(
      sent
        .filter(r => r.url.includes('$export-file'))
        .every(r => r.headers.get('Accept') === 'application/fhir+ndjson'),
    ).toBe(true);
  });

  it("exports a group's patients, since an instant; the server's refusal is an error", async () => {
    const { fetch } = await serverWith();
    const c = client(fetch);
    const all = await c.bulkExport({
      level: { group: 'g1' },
      types: ['Patient', 'Observation'],
    });
    expect(idsByType(await collect(all.resources(await all.wait())))).toEqual({
      Observation: ['o1', 'o3'],
      Patient: ['p1'],
    });
    // after the set-up's last write, by the store's clock (it runs ahead of
    // the server's), then a change
    const since = new Date(
      (await (await c.request('GET', 'Group/g1')).json()).meta.lastUpdated,
    );
    await c.request('PUT', 'Observation/o3', {
      body: JSON.stringify({ ...obs('o3', 'p1'), status: 'amended' }),
    });
    const group = await c.bulkExport({
      level: { group: 'g1' },
      types: ['Patient', 'Observation'],
      since,
    });
    expect(
      idsByType(await collect(group.resources(await group.wait()))),
    ).toEqual({ Observation: ['o3'] });
    const patients = await c.bulkExport({
      level: 'patient',
      types: ['Patient'],
    });
    expect((await patients.wait()).request).toBe(
      `${BASE}/Patient/$export?_type=Patient`,
    );
    const e = await c.bulkExport({ params: { nope: 'x' } }).catch(x => x);
    expect(e).toBeInstanceOf(FhirClientError);
    expect([e.status, e.diagnostics]).toEqual([
      400,
      ['$export: nope is not supported'],
    ]);
    await expect(c.bulkExport({ level: { group: '../x' } })).rejects.toThrow(
      '"../x" is not a FHIR id',
    );
  });

  it('sends _typeFilter and _elements; reads the deletions; a 429 of the kick-off is an error', async () => {
    const { fetch, sent } = await serverWith();
    const c = client(fetch);
    const filtered = await c.bulkExport({
      types: ['Observation'],
      typeFilters: { Observation: ['subject=Patient/p2', '_id=o1,o3'] },
    });
    const kickOff = new URL(sent.find(r => r.url.includes('/$export?'))!.url);
    expect(kickOff.searchParams.getAll('_typeFilter')).toEqual([
      'Observation?subject=Patient/p2',
      'Observation?_id=o1,o3',
    ]);
    expect(
      idsByType(await collect(filtered.resources(await filtered.wait()))),
    ).toEqual({ Observation: ['o1', 'o2', 'o3'] });
    const one = await c.bulkExport({
      types: ['Observation'],
      typeFilters: { Observation: 'subject=Patient/p1' },
    });
    expect(idsByType(await collect(one.resources(await one.wait())))).toEqual({
      Observation: ['o1', 'o3'],
    });

    const subset = await c.bulkExport({
      types: ['Patient', 'Observation'],
      elements: ['id', 'Observation.status'],
    });
    const parts = await collect(subset.resources(await subset.wait()));
    const o1 = parts.find(r => r.id === 'o1');
    expect([o1.status, o1.subject, o1.meta.tag[0].code]).toEqual([
      'final',
      undefined,
      'SUBSETTED',
    ]);

    // after the last write, by the store's clock; then a deletion
    const g1 = await (await c.request('GET', 'Group/g1')).json();
    await (await c.request('DELETE', 'Observation/o2')).body?.cancel();
    const since = await c.bulkExport({ since: g1.meta.lastUpdated });
    const manifest = await since.wait();
    expect(manifest.output).toEqual([]);
    expect(await collect(since.deleted(manifest))).toEqual([
      { type: 'Observation', id: 'o2' },
    ]);
    // a manifest without deletions: none
    expect(await collect(one.deleted(await one.wait()))).toEqual([]);

    // the server's limit on exports at once
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const inner = new MemoryStore();
    const store: FhirStore = Object.create(inner);
    store.search = async (type, query) => {
      await gate;
      return inner.search(type, query);
    };
    const busy = await serverWith({ store, maxExports: 1 });
    const b = client(busy.fetch);
    await b.bulkExport({ types: ['Patient'] });
    const e = await b.bulkExport({ types: ['Patient'] }).catch(x => x);
    expect([e.constructor.name, e.status]).toEqual(['FhirClientError', 429]);
    release();
    await busy.server.bulkExport!.idle();
  });

  it('names the patients in a POST; asks for the Provenance of the resources', async () => {
    const { fetch, sent } = await serverWith({ provenance: true });
    const c = client(fetch);
    const job = await c.bulkExport({
      level: 'patient',
      types: ['Patient', 'Observation'],
      patients: ['Patient/p2'],
    });
    const kickOff = sent.find(r => r.url.endsWith('/Patient/$export'))!;
    expect([kickOff.method, kickOff.headers.get('Content-Type')]).toEqual([
      'POST',
      'application/fhir+json',
    ]);
    expect(await kickOff.json()).toEqual({
      resourceType: 'Parameters',
      parameter: [
        { name: '_type', valueString: 'Patient,Observation' },
        { name: 'patient', valueReference: { reference: 'Patient/p2' } },
      ],
    });
    expect(idsByType(await collect(job.resources(await job.wait())))).toEqual({
      Observation: ['o2'],
      Patient: ['p2'],
    });
    const e = await c
      .bulkExport({ level: { group: 'g1' }, patients: ['Patient/p2'] })
      .catch(x => x);
    expect([e.status, e.diagnostics]).toEqual([
      400,
      ['Patient/p2 is not a member of Group/g1'],
    ]);
    await expect(c.bulkExport({ patients: ['Patient/p1'] })).rejects.toThrow(
      'patients are for the patients or a group',
    );

    for (const [id, recorded] of [
      ['pv1', '2026-01-01T00:00:00Z'],
      ['pv2', '2026-02-01T00:00:00Z'],
    ])
      await (
        await c.request('PUT', `Provenance/${id}`, {
          body: JSON.stringify({
            resourceType: 'Provenance',
            id,
            recorded,
            target: [{ reference: 'Observation/o1' }],
            agent: [{ who: { reference: 'Practitioner/x' } }],
          }),
        })
      ).body?.cancel();
    const latest = await c.bulkExport({
      types: ['Observation'],
      includeAssociatedData: ['LatestProvenanceResources'],
    });
    expect(sent.at(-1)!.url).toBe(
      `${BASE}/$export?_type=Observation&includeAssociatedData=LatestProvenanceResources`,
    );
    expect(
      idsByType(await collect(latest.resources(await latest.wait()))),
    ).toEqual({ Observation: ['o1', 'o2', 'o3'], Provenance: ['pv2'] });
    // with patients, in the POST's Parameters
    const both = await c.bulkExport({
      level: 'patient',
      types: ['Observation'],
      patients: ['Patient/p1'],
      includeAssociatedData: ['RelevantProvenanceResources'],
    });
    expect((await sent.at(-1)!.json()).parameter).toContainEqual({
      name: 'includeAssociatedData',
      valueCode: 'RelevantProvenanceResources',
    });
    expect(idsByType(await collect(both.resources(await both.wait())))).toEqual(
      { Observation: ['o1', 'o3'], Provenance: ['pv1', 'pv2'] },
    );
  });

  it('reports its progress while it runs; a cancel stops it', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const inner = new MemoryStore();
    const store: FhirStore = Object.create(inner);
    store.search = async (type, query) => {
      if (type === 'Observation') await gate;
      return inner.search(type, query);
    };
    const { fetch, server } = await serverWith({ store });
    const c = client(fetch);
    const job = await c.bulkExport({ types: ['Patient', 'Observation'] });
    const progress: (string | undefined)[] = [];
    const done = job.wait({
      interval: 5,
      onProgress: p => {
        progress.push(p);
        // asked again while Observation waits
        if (progress.filter(x => x === 'Observation (2 of 2)').length === 2)
          release();
      },
    });
    const manifest = await done;
    expect(progress.filter(x => x === 'Observation (2 of 2)').length).toBe(2);
    expect(manifest.output.length).toBe(4);

    // a cancel: the status is gone
    const other = await c.bulkExport({ types: ['Patient'] });
    await server.bulkExport!.idle();
    await other.cancel();
    const e = await other.status().catch(x => x);
    expect([e.status, e.diagnostics]).toEqual([
      404,
      [`No export ${other.statusUrl.split('/').pop()}`],
    ]);
  });

  it("reads the files with the client's token; the OperationOutcomes of its errors", async () => {
    const { fetch, sent } = await serverWith({ secure: true });
    const c = client(fetch, 'token-obs');
    const job = await c.bulkExport();
    const manifest = await job.wait();
    expect(manifest.requiresAccessToken).toBe(true);
    expect(idsByType(await collect(job.resources(manifest)))).toEqual({
      Observation: ['o1', 'o2', 'o3'],
    });
    // the types the token does not grant, left out
    const errors = await collect(job.errors(manifest));
    expect(errors.map(o => o.issue[0].diagnostics).sort()).toEqual([
      'Group is not allowed to the caller',
      'Medication is not allowed to the caller',
      'Patient is not allowed to the caller',
    ]);
    expect(
      sent
        .filter(r => r.url.includes('$export'))
        .every(r => r.headers.get('Authorization') === 'Bearer token-obs'),
    ).toBe(true);
    // without the token, and with another's
    const anonymous = await new FhirBulkExportOf(client(fetch), job)
      .status()
      .catch(x => x);
    expect(anonymous.status).toBe(401);
    const others = await new FhirBulkExportOf(
      client(fetch, 'token-system'),
      job,
    )
      .status()
      .catch(x => x);
    expect(others.status).toBe(404);
    // a file the manifest says needs the token, on another server: not sent there
    const elsewhere: FhirBulkManifest = {
      ...manifest,
      output: [{ type: 'Patient', url: 'https://files.example/p.ndjson' }],
    };
    await expect(collect(job.resources(elsewhere))).rejects.toThrow(
      'https://files.example/p.ndjson is not on the server http://localhost/fhir',
    );
  });

  it("reads a storage's own URLs without the token", async () => {
    const files = new MemoryExportStorage();
    const signed: ExportStorage = {
      create: (job, file) => files.create(job, file),
      read: (job, file) => files.read(job, file),
      delete: job => files.delete(job),
      url: async (job, file) => `https://files.example/${job}/${file}?sig=x`,
    };
    const { fetch: server, sent } = await serverWith({
      secure: true,
      storage: signed,
    });
    // the object store answers its own URLs
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = new Request(input, init);
      const m = /^https:\/\/files\.example\/([^/]+)\/([^?]+)/.exec(r.url);
      if (!m) return server(r);
      sent.push(r);
      return new Response(await files.read(m[1], m[2]));
    }) as typeof globalThis.fetch;
    const c = client(fetch, 'token-system');
    const job = await c.bulkExport({ types: ['Patient'] });
    const manifest = await job.wait();
    expect(manifest.requiresAccessToken).toBe(false);
    expect(idsByType(await collect(job.resources(manifest)))).toEqual({
      Patient: ['p1', 'p2', 'p3'],
    });
    const fromStore = sent.filter(r =>
      r.url.startsWith('https://files.example/'),
    );
    expect(fromStore.length).toBe(2);
    expect(fromStore.every(r => !r.headers.has('Authorization'))).toBe(true);
  });

  it('waits as Retry-After says (capped), takes a 429, stops on abort; reads lines split across chunks', async () => {
    const answers: Response[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = new Request(input, init);
      if (r.url.endsWith('/$export'))
        return new Response(null, {
          status: 202,
          headers: { 'Content-Location': `${BASE}/status/1` },
        });
      if (r.url.endsWith('/file.ndjson')) {
        const parts = [
          '{"resourceType":"Patient","id":"a"}\n{"resource',
          'Type":"Patient","id":"b"}\n',
          '\n{"resourceType":"Patient","id":"c"}',
        ];
        return new Response(
          new ReadableStream({
            start(controller) {
              for (const p of parts)
                controller.enqueue(new TextEncoder().encode(p));
              controller.close();
            },
          }),
        );
      }
      return answers.shift()!;
    }) as typeof globalThis.fetch;
    const c = client(fetch);
    const job = await c.bulkExport();
    const manifest = {
      transactionTime: '2026-11-23T00:00:00Z',
      request: `${BASE}/$export`,
      requiresAccessToken: false,
      output: [{ type: 'Patient', url: `${BASE}/file.ndjson` }],
    };
    answers.push(
      new Response(null, { status: 429, headers: { 'Retry-After': '120' } }),
      new Response(null, {
        status: 202,
        headers: {
          'X-Progress': 'half',
          'Retry-After': new Date(Date.now() + 120_000).toUTCString(),
        },
      }),
      Response.json(manifest),
    );
    const progress: (string | undefined)[] = [];
    const started = Date.now();
    const m = await job.wait({
      maxInterval: 5,
      onProgress: p => progress.push(p),
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(progress).toEqual([undefined, 'half']);
    expect(m.error).toEqual([]);
    expect((await collect(job.resources(m))).map(r => r.id)).toEqual([
      'a',
      'b',
      'c',
    ]);

    // an abort stops the wait
    answers.push(
      new Response(null, { status: 202, headers: { 'Retry-After': '60' } }),
    );
    const abort = new AbortController();
    const waiting = job.wait({ signal: abort.signal });
    setTimeout(() => abort.abort(new Error('stopped')), 10);
    await expect(waiting).rejects.toThrow('stopped');
  });
});

/** The same export, asked by another client */
class FhirBulkExportOf {
  constructor(
    private readonly c: FhirClient,
    private readonly job: { statusUrl: string },
  ) {}
  status() {
    return this.c.request('GET', this.job.statusUrl, {
      headers: { Accept: 'application/json' },
    });
  }
}
