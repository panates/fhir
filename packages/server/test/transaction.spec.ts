import { FhirClient } from '@fhirjs/client';
import { FhirContext } from '@fhirjs/core';
import { r4Model } from '@fhirjs/r4';
import { expect } from 'expect';
import {
  type FhirStore,
  FhirServer,
  MemoryStore,
  type StoreCapabilities,
} from '../src/index.js';

const fhir = new FhirContext(r4Model);
const SYS = 'urn:tx';
const P1 = 'urn:uuid:7d0a9d4e-1c1e-4b53-9d3e-2f2c3b0a0001';
const O1 = 'urn:uuid:7d0a9d4e-1c1e-4b53-9d3e-2f2c3b0a0002';

const transaction = (...entry: object[]) => ({
  resourceType: 'Bundle',
  type: 'transaction',
  entry,
});
const obs = (extra: object = {}) => ({
  resourceType: 'Observation',
  status: 'final',
  code: { text: 'x' },
  ...extra,
});

/** A server on its own store, and how to send it a Bundle */
function serverOf(
  options: Partial<ConstructorParameters<typeof FhirServer>[0]> = {},
) {
  const server = new FhirServer({ fhir, store: new MemoryStore(), ...options });
  const send = async (bundle: object) => {
    const r = await server.handle(
      new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/fhir+json' },
        body: JSON.stringify(bundle),
      }),
    );
    return { status: r.status, body: await r.json() };
  };
  const get = async (path: string) =>
    (await server.handle(new Request(`http://localhost/${path}`))).json();
  return { server, send, get };
}

describe('FhirServer: transaction', () => {
  it('runs deletes, creates, updates, then reads, and answers in the order of the request', async () => {
    const { send, get } = serverOf();
    await send(
      transaction(
        {
          resource: { resourceType: 'Patient', id: 'old' },
          request: { method: 'PUT', url: 'Patient/old' },
        },
        {
          resource: { resourceType: 'Patient', id: 'kept', active: true },
          request: { method: 'PUT', url: 'Patient/kept' },
        },
      ),
    );
    const { status, body } = await send(
      transaction(
        // a search first in the Bundle, run last: it sees the writes
        { request: { method: 'GET', url: `Patient?identifier=${SYS}|1` } },
        {
          fullUrl: O1,
          resource: obs({ subject: { reference: P1 } }),
          request: { method: 'POST', url: 'Observation' },
        },
        {
          fullUrl: P1,
          resource: {
            resourceType: 'Patient',
            identifier: [{ system: SYS, value: '1' }],
            // a cycle: the patient refers to the observation that refers to it
            link: [{ other: { reference: 'Patient/kept' }, type: 'seealso' }],
            extension: [
              { url: 'urn:tx:obs', valueReference: { reference: O1 } },
            ],
          },
          request: { method: 'POST', url: 'Patient' },
        },
        {
          resource: {
            resourceType: 'Binary',
            contentType: 'application/json-patch+json',
            data: Buffer.from(
              JSON.stringify([
                { op: 'replace', path: '/active', value: false },
              ]),
            ).toString('base64'),
          },
          request: { method: 'PATCH', url: 'Patient/kept' },
        },
        { request: { method: 'DELETE', url: 'Patient/old' } },
      ),
    );
    expect(status).toBe(200);
    expect(body.type).toBe('transaction-response');
    expect(body.entry.map((e: any) => e.response.status)).toEqual([
      '200 OK',
      '201 Created',
      '201 Created',
      '200 OK',
      '204 No Content',
    ]);
    const [search, o, p] = body.entry;
    expect(search.resource.total).toBe(1);
    const pid = p.resource.id;
    expect(p.response.location).toBe(
      `http://localhost/Patient/${pid}/_history/1`,
    );
    expect(o.resource.subject.reference).toBe(`Patient/${pid}`);
    expect(p.resource.extension[0].valueReference.reference).toBe(
      `Observation/${o.resource.id}`,
    );
    expect((await get(`Patient/${pid}`)).id).toBe(pid);
    expect((await get('Patient/kept')).active).toBe(false);
    expect((await get('Patient/old')).issue[0].code).toBe('deleted');
  });

  it('writes nothing when an entry fails, and answers with its status', async () => {
    const { send, get } = serverOf();
    await send(
      transaction({
        resource: { resourceType: 'Patient', id: 'p' },
        request: { method: 'PUT', url: 'Patient/p' },
      }),
    );
    const before = (await get('_history')).total;
    const failing = [
      // an Observation that is not valid
      obs({ status: 'not-a-status' }),
    ];
    const invalid = await send(
      transaction(
        {
          resource: { resourceType: 'Patient', id: 'p', active: true },
          request: { method: 'PUT', url: 'Patient/p' },
        },
        { request: { method: 'DELETE', url: 'Patient/p' } },
        {
          fullUrl: P1,
          resource: { resourceType: 'Patient' },
          request: { method: 'POST', url: 'Patient' },
        },
        {
          resource: failing[0],
          request: { method: 'POST', url: 'Observation' },
        },
      ),
    );
    expect(invalid.status).toBe(422);
    expect(invalid.body.issue[0].diagnostics).toMatch(/^Entry 3: /);
    expect(invalid.body.issue[0].expression).toEqual(['Observation.status']);
    const stale = await send(
      transaction({
        resource: { resourceType: 'Patient', id: 'p', active: true },
        request: { method: 'PUT', url: 'Patient/p', ifMatch: 'W/"9"' },
      }),
    );
    expect(`${stale.status} ${stale.body.issue[0].diagnostics}`).toBe(
      '412 Entry 0: Patient/p: version 9 is not the current one (1)',
    );
    expect((await get('_history')).total).toBe(before);
    expect((await get('Patient/p')).active).toBeUndefined();
  });

  it('resolves conditional references and conditional creates by a search', async () => {
    const { send, get } = serverOf();
    await send(
      transaction(
        {
          resource: {
            resourceType: 'Patient',
            id: 'known',
            identifier: [{ system: SYS, value: 'k' }],
          },
          request: { method: 'PUT', url: 'Patient/known' },
        },
        {
          resource: {
            resourceType: 'Patient',
            id: 'twin1',
            identifier: [{ system: SYS, value: 'twin' }],
          },
          request: { method: 'PUT', url: 'Patient/twin1' },
        },
        {
          resource: {
            resourceType: 'Patient',
            id: 'twin2',
            identifier: [{ system: SYS, value: 'twin' }],
          },
          request: { method: 'PUT', url: 'Patient/twin2' },
        },
      ),
    );
    const { body } = await send(
      transaction(
        {
          resource: obs({
            subject: { reference: `Patient?identifier=${SYS}|k` },
          }),
          request: { method: 'POST', url: 'Observation' },
        },
        // finds the known patient: referred to as that one, not created
        {
          fullUrl: P1,
          resource: {
            resourceType: 'Patient',
            identifier: [{ system: SYS, value: 'k' }],
          },
          request: {
            method: 'POST',
            url: 'Patient',
            ifNoneExist: `identifier=${SYS}|k`,
          },
        },
        {
          resource: obs({ subject: { reference: P1 } }),
          request: { method: 'POST', url: 'Observation' },
        },
      ),
    );
    expect(body.entry.map((e: any) => e.response.status)).toEqual([
      '201 Created',
      '200 OK',
      '201 Created',
    ]);
    expect(body.entry[0].resource.subject.reference).toBe('Patient/known');
    expect(body.entry[2].resource.subject.reference).toBe('Patient/known');
    const count = (await get('Observation')).total;
    for (const value of ['none', 'twin']) {
      const r = await send(
        transaction(
          {
            resource: obs(),
            request: { method: 'POST', url: 'Observation' },
          },
          {
            resource: obs({
              subject: { reference: `Patient?identifier=${SYS}|${value}` },
            }),
            request: { method: 'POST', url: 'Observation' },
          },
        ),
      );
      expect(`${r.status} ${r.body.issue[0].diagnostics}`).toBe(
        `412 Entry 1: the conditional reference Patient?identifier=${SYS}|${value} finds ${value === 'none' ? 'no' : 'more than one'} Patient`,
      );
    }
    expect((await get('Observation')).total).toBe(count);
  });

  it('refuses the whole transaction when the caller may not do one entry', async () => {
    const { send, get } = serverOf({
      security: {
        authenticators: [],
        anonymous: true,
        authorizer: {
          async authorize(access) {
            return access.interaction === 'delete'
              ? { allowed: false, reason: 'No deletes' }
              : { allowed: true };
          },
        },
      },
    });
    const r = await send(
      transaction(
        {
          resource: { resourceType: 'Patient', id: 'a' },
          request: { method: 'PUT', url: 'Patient/a' },
        },
        { request: { method: 'DELETE', url: 'Patient/b' } },
      ),
    );
    expect(`${r.status} ${r.body.issue[0].diagnostics}`).toBe(
      '403 Entry 1: No deletes',
    );
    expect((await get('Patient')).total).toBe(0);
  });

  it('is refused by a store without transactions, and for new resources a store cannot name', async () => {
    const put = transaction({
      resource: { resourceType: 'Patient', id: 'a' },
      request: { method: 'PUT', url: 'Patient/a' },
    });
    // a store without transaction(), as most facades start
    const memory = new MemoryStore();
    const plain: FhirStore = {
      capabilities: () => memory.capabilities(),
      read: (t, i) => memory.read(t, i),
      update: (t, i, r, m) => memory.update(t, i, r, m),
      search: (t, q) => memory.search(t, q),
    };
    const none = serverOf({ store: plain, resources: ['Patient'] });
    const refused = await none.send(
      transaction(...put.entry, {
        request: { method: 'GET', url: 'Observation' },
      }),
    );
    expect(`${refused.status} ${refused.body.issue[0].diagnostics}`).toBe(
      '404 Entry 1: resource type Observation is not served',
    );
    expect(
      (await none.get('metadata')).rest[0].interaction.map((i: any) => i.code),
    ).not.toContain('transaction');
    expect((await none.send(put)).body.issue[0].diagnostics).toBe(
      'Transactions are not supported: the store has no transaction()',
    );
    // the store gives ids itself: no placeholders
    const caps: StoreCapabilities = {
      ...memory.capabilities(),
      acceptsIds: false,
    };
    const naming: FhirStore = Object.assign(
      Object.create(memory) as MemoryStore,
      { capabilities: () => caps },
    );
    const r = await serverOf({ store: naming, resources: ['Patient'] }).send(
      transaction({
        fullUrl: P1,
        resource: { resourceType: 'Patient' },
        request: { method: 'POST', url: 'Patient' },
      }),
    );
    expect(`${r.status} ${r.body.issue[0].diagnostics}`).toBe(
      '400 Entry 0: the store of Patient gives ids itself, so a transaction cannot refer to a new Patient by its fullUrl',
    );
  });

  it('is sent by the client, and listed in the CapabilityStatement', async () => {
    const { server } = serverOf();
    const client = new FhirClient({
      baseUrl: 'http://localhost',
      fhir,
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        server.handle(new Request(input, init)),
    } as any);
    const answer = await client.transaction(
      transaction({
        resource: { resourceType: 'Patient', id: 'c' },
        request: { method: 'PUT', url: 'Patient/c' },
      }),
    );
    expect(answer.entry[0].response.status).toBe('201 Created');
    const cs = await client.capabilities();
    expect(cs.rest[0].interaction.map((i: any) => i.code)).toEqual([
      'batch',
      'transaction',
      'history-system',
    ]);
  });
});

describe('MemoryStore: transaction', () => {
  it('undoes its writes when the work fails, and holds other requests until it ends', async () => {
    const store = new MemoryStore();
    await store.update('Patient', 'a', { resourceType: 'Patient' });
    let outside: Promise<unknown> | undefined;
    await expect(
      store.transaction(async tx => {
        await tx.update!('Patient', 'a', {
          resourceType: 'Patient',
          active: true,
        });
        await tx.create!('Patient', { resourceType: 'Patient', id: 'b' });
        // the transaction sees its writes; a request outside waits
        expect((await tx.read!('Patient', 'b'))?.id).toBe('b');
        outside = store.read('Patient', 'b');
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect(await outside).toBeUndefined();
    expect(
      (await store.read('Patient', 'a'))?.resource?.active,
    ).toBeUndefined();
    expect(
      (await store.history('Patient', 'a', { count: 9, offset: 0 })).total,
    ).toBe(1);
    const kept = await store.transaction(async tx =>
      tx.create!('Patient', { resourceType: 'Patient', id: 'b' }),
    );
    expect(kept.id).toBe('b');
    await expect(
      store.create('Patient', { resourceType: 'Patient', id: 'b' }),
    ).rejects.toThrow('Patient/b exists already');
  });
});
