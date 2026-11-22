import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FhirClient } from '@fhirjs/client';
import { FhirContext } from '@fhirjs/core';
import { r4Model } from '@fhirjs/r4';
import { expect } from 'expect';
import {
  type FhirAuthenticator,
  FhirServer,
  MemoryStore,
  nodeListener,
} from '../src/index.js';

const fhir = new FhirContext(r4Model);
const SYS = 'urn:batch';
const patch = (ops: object[]) => ({
  resourceType: 'Binary',
  contentType: 'application/json-patch+json',
  data: Buffer.from(JSON.stringify(ops)).toString('base64'),
});

describe('FhirServer: batch', () => {
  let server: FhirServer;
  let base: string;
  let client: FhirClient;
  let stop: () => Promise<void>;

  before(async () => {
    server = new FhirServer({
      fhir,
      store: new MemoryStore(),
      base: '/fhir',
      maxBundleEntries: 10,
    });
    const httpServer = http.createServer(nodeListener(server));
    await new Promise<void>(r => httpServer.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/fhir`;
    client = new FhirClient({ baseUrl: base, fhir });
    stop = () => new Promise<void>(r => httpServer.close(() => r()));
  });
  after(() => stop());

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const batch = (...entry: object[]) => ({
    resourceType: 'Bundle',
    type: 'batch',
    entry,
  });
  const outcome = async (r: Response) =>
    `${r.status} ${(await r.json()).issue[0].diagnostics}`;

  it('runs each entry as a request of its own, in order, and answers each', async () => {
    const r = await post(
      batch(
        {
          resource: {
            resourceType: 'Patient',
            identifier: [{ system: SYS, value: '1' }],
          },
          request: { method: 'POST', url: 'Patient' },
        },
        {
          resource: { resourceType: 'Patient', id: 'b1', active: true },
          request: { method: 'PUT', url: 'Patient/b1' },
        },
        { request: { method: 'GET', url: 'Patient/b1' } },
        { request: { method: 'GET', url: `Patient?identifier=${SYS}|1` } },
        { request: { method: 'DELETE', url: 'Patient/nothing-here' } },
        {
          resource: patch([{ op: 'replace', path: '/active', value: false }]),
          request: { method: 'PATCH', url: 'Patient/b1' },
        },
        // a failing entry does not stop the others
        {
          resource: {
            resourceType: 'Observation',
            status: 'not-a-status',
            code: { text: 'x' },
          },
          request: { method: 'POST', url: 'Observation' },
        },
        { request: { method: 'GET', url: 'Patient/b1/_history' } },
      ),
    );
    expect(r.status).toBe(200);
    const bundle = await r.json();
    expect(bundle.type).toBe('batch-response');
    expect(bundle.entry.map((e: any) => e.response.status)).toEqual([
      '201 Created',
      '201 Created',
      '200 OK',
      '200 OK',
      '204 No Content',
      '200 OK',
      '422 Unprocessable Entity',
      '200 OK',
    ]);
    const [created, put, read, search, , patched, failed, history] =
      bundle.entry;
    expect(created.response.location).toMatch(
      new RegExp(`^${base}/Patient/[0-9a-f-]+/_history/1$`),
    );
    expect(created.response.etag).toBe('W/"1"');
    expect(created.response.lastModified).toBe(
      created.resource.meta.lastUpdated,
    );
    expect(put.resource.id).toBe('b1');
    expect(read.resource.active).toBe(true);
    expect(search.resource).toMatchObject({
      resourceType: 'Bundle',
      type: 'searchset',
      total: 1,
    });
    expect(patched.resource).toMatchObject({
      active: false,
      meta: { versionId: '2' },
    });
    expect(failed.resource).toBeUndefined();
    expect(failed.response.outcome.issue[0].expression).toEqual([
      'Observation.status',
    ]);
    expect(history.resource.total).toBe(2);
    expect(
      fhir.validate(bundle).issues.filter((i: any) => i.severity === 'error'),
    ).toEqual([]);
  });

  it('answers as Prefer asks for the Bundle, and keeps the places of decimals', async () => {
    const minimal = await (
      await post(
        batch({
          resource: { resourceType: 'Patient' },
          request: { method: 'POST', url: 'Patient' },
        }),
        { Prefer: 'return=minimal' },
      )
    ).json();
    expect(minimal.entry[0].resource).toBeUndefined();
    expect(minimal.entry[0].response.status).toBe('201 Created');
    const text = await (
      await post(
        '{"resourceType":"Bundle","type":"batch","entry":[{"resource":{"resourceType":"Observation","status":"final","code":{"text":"dose"},"valueQuantity":{"value":1.50}},"request":{"method":"POST","url":"Observation"}}]}',
      )
    ).text();
    expect(text).toContain('"value":1.50');
  });

  it('answers 400 for an entry it cannot read, and goes on', async () => {
    const bundle = await (
      await post(
        batch(
          { request: { url: 'Patient' } },
          { request: { method: 'GET', url: 'http://elsewhere/fhir/Patient' } },
          { request: { method: 'POST', url: '/' } },
          {
            resource: { resourceType: 'Patient' },
            request: { method: 'PATCH', url: 'Patient/b1' },
          },
          { request: { method: 'GET', url: 'Patient/b1' } },
        ),
      )
    ).json();
    expect(
      bundle.entry.map(
        (e: any) =>
          `${e.response.status}: ${e.response.outcome?.issue[0].diagnostics ?? ''}`,
      ),
    ).toEqual([
      '400 Bad Request: Entry 0: request.method "undefined" is not one',
      '400 Bad Request: Entry 1: request.url must be relative to the server base',
      '400 Bad Request: Entry 2: a batch cannot hold a request on the server base',
      '400 Bad Request: Entry 3: a patch is a Binary with the JSON Patch as its data',
      '200 OK: ',
    ]);
  });

  it('refuses what is not a batch it takes', async () => {
    const eleven = batch(
      ...Array.from({ length: 11 }, () => ({
        request: { method: 'GET', url: 'metadata' },
      })),
    );
    expect([
      await outcome(await post('{"resourceType":"Patient"}')),
      await outcome(
        await post({ resourceType: 'Bundle', type: 'transaction', entry: [] }),
      ),
      await outcome(await post({ resourceType: 'Bundle', type: 'history' })),
      await outcome(await post(eleven)),
      await outcome(await fetch(base)),
      await outcome(
        await post('{"resourceType":"Bundle","type":"batch"}', {
          'Content-Type': 'application/xml',
        }),
      ),
    ]).toEqual([
      '400 POST [base] takes a Bundle',
      '400 Transactions are not supported yet; send a batch',
      '400 POST [base] takes a batch Bundle, not a history',
      '413 The Bundle has 11 entries; this server takes 10 at most',
      '405 GET is not supported on the server base',
      '415 A Bundle is sent as application/fhir+json, not application/xml',
    ]);
    // an empty batch has an empty answer
    expect(await (await post(batch())).json()).toEqual({
      resourceType: 'Bundle',
      type: 'batch-response',
    });
  });

  it('is sent by the client, and listed in the CapabilityStatement', async () => {
    const answer = await client.batch(
      batch({ request: { method: 'GET', url: 'Patient/b1' } }),
    );
    expect(answer.entry[0].response.status).toBe('200 OK');
    const cs = await client.capabilities();
    expect(cs.rest[0].interaction.map((i: any) => i.code)).toContain('batch');
  });
});

describe('FhirServer: batch with security', () => {
  /** A caller from a header; only admins delete */
  const caller: FhirAuthenticator = {
    async authenticate(request) {
      const who = request.headers.get('X-Who');
      return who
        ? { subject: who, method: 'test', scopes: [], claims: {} }
        : undefined;
    },
  };
  const server = new FhirServer({
    fhir,
    store: new MemoryStore(),
    resources: ['Patient'],
    security: {
      authenticators: [caller],
      authorizer: {
        async authorize(access) {
          return access.interaction === 'delete' &&
            access.principal?.subject !== 'admin'
            ? { allowed: false, reason: 'Only admins delete' }
            : { allowed: true };
        },
      },
    },
  });
  const send = (who: string | undefined, entry: object[]) =>
    server.handle(
      new Request('http://localhost/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/fhir+json',
          ...(who ? { 'X-Who': who } : {}),
        },
        body: JSON.stringify({ resourceType: 'Bundle', type: 'batch', entry }),
      }),
    );

  it('authenticates the Bundle once, and authorizes each entry', async () => {
    expect((await send(undefined, [])).status).toBe(401);
    const bundle = await (
      await send('user', [
        {
          resource: { resourceType: 'Patient', id: 's1' },
          request: { method: 'PUT', url: 'Patient/s1' },
        },
        { request: { method: 'DELETE', url: 'Patient/s1' } },
      ])
    ).json();
    expect(bundle.entry.map((e: any) => e.response.status)).toEqual([
      '201 Created',
      '403 Forbidden',
    ]);
    expect(bundle.entry[1].response.outcome.issue[0].diagnostics).toBe(
      'Only admins delete',
    );
    const admin = await (
      await send('admin', [
        { request: { method: 'DELETE', url: 'Patient/s1' } },
      ])
    ).json();
    expect(admin.entry[0].response.status).toBe('204 No Content');
  });
});
