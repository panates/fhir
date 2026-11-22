import { FhirContext } from '@fhirjs/core';
import { r4Model } from '@fhirjs/r4';
import { expect } from 'expect';
import {
  type FhirStore,
  FhirServer,
  MemoryStore,
  RoutingStore,
} from '../src/index.js';

const fhir = new FhirContext(r4Model);

function serverOf(store: FhirStore) {
  const server = new FhirServer({
    fhir,
    store,
    resources: ['Patient', 'Observation', 'Organization'],
  });
  const send = async (path: string, init: RequestInit = {}) => {
    const r = await server.handle(
      new Request(`http://localhost/${path}`, init),
    );
    const body = await r.json();
    return r.status >= 400 ? `${r.status} ${body.issue[0].diagnostics}` : body;
  };
  const post = (bundle: object) =>
    send('', {
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json' },
      body: JSON.stringify(bundle),
    });
  const interactions = async () =>
    (await send('metadata')).rest[0].interaction.map((i: any) => i.code);
  return { server, send, post, interactions };
}

const transaction = (...entry: object[]) => ({
  resourceType: 'Bundle',
  type: 'transaction',
  entry,
});

describe('RoutingStore', () => {
  it('sends each type to its store, and the others to the default one', async () => {
    const main = new MemoryStore();
    const patients = new MemoryStore();
    const store = new RoutingStore({
      store: main,
      routes: { Patient: patients },
    });
    await store.update('Patient', 'p1', { resourceType: 'Patient', id: 'p1' });
    await store.update('Observation', 'o1', {
      resourceType: 'Observation',
      id: 'o1',
      status: 'final',
      code: { text: 'x' },
    });
    expect(await patients.read('Patient', 'p1')).toBeDefined();
    expect(await main.read('Patient', 'p1')).toBeUndefined();
    expect(await main.read('Observation', 'o1')).toBeDefined();
    expect(store.storeOf('Patient')).toBe(patients);
    expect(store.storeOf('Encounter')).toBe(main);
    // without a default store, only the types routed
    const only = new RoutingStore({ routes: { Patient: patients } });
    expect(only.capabilities('Observation')).toBeUndefined();
    await expect(only.read('Observation', 'o1')).rejects.toThrow(
      'read of Observation is not supported',
    );
  });

  it('declares chains only to the types of the same store', () => {
    const main = new MemoryStore();
    const store = new RoutingStore({
      store: main,
      routes: { Organization: new MemoryStore(), Encounter: main },
    });
    const chains = store.capabilities('Observation')!.chains as (
      t: string,
    ) => boolean;
    expect(['Patient', 'Encounter', 'Organization'].map(chains)).toEqual([
      true,
      true,
      false,
    ]);
    const alone = new RoutingStore({ store: main, routes: {} });
    expect(
      (alone.capabilities('Observation')!.chains as (t: string) => boolean)(
        'Organization',
      ),
    ).toBe(true);
    const off: FhirStore = {
      capabilities: () => ({ ...main.capabilities(), chains: false }),
    };
    expect(
      new RoutingStore({ store: off, routes: {} }).capabilities('Patient')!
        .chains,
    ).toBe(false);
  });

  it('runs a transaction in the default store, and refuses writes to the others', async () => {
    const organizations = new MemoryStore();
    await organizations.update('Organization', 'org1', {
      resourceType: 'Organization',
      id: 'org1',
      name: 'acme',
    });
    const { post, send, interactions } = serverOf(
      new RoutingStore({
        store: new MemoryStore(),
        routes: { Organization: organizations },
      }),
    );
    expect(await interactions()).toContain('transaction');
    // reads the other store: a conditional reference to it is resolved
    const done = await post(
      transaction({
        resource: {
          resourceType: 'Patient',
          id: 'p1',
          managingOrganization: { reference: 'Organization?name=acme' },
        },
        request: { method: 'PUT', url: 'Patient/p1' },
      }),
    );
    expect(done.entry[0].resource.managingOrganization.reference).toBe(
      'Organization/org1',
    );
    // a write to the other store fails the whole transaction
    expect(
      await post(
        transaction(
          {
            resource: { resourceType: 'Patient', id: 'p2' },
            request: { method: 'PUT', url: 'Patient/p2' },
          },
          {
            resource: { resourceType: 'Organization', id: 'org2', name: 'b' },
            request: { method: 'PUT', url: 'Organization/org2' },
          },
        ),
      ),
    ).toBe(
      '400 Entry 1: Organization is in a store of its own, which takes no part in the transaction',
    );
    expect(await send('Patient/p2')).toMatch(/^404/);
    expect(await organizations.read('Organization', 'org2')).toBeUndefined();
    // a default store without transactions: none
    const memory = new MemoryStore();
    const plain: FhirStore = {
      capabilities: () => memory.capabilities(),
      read: (t, i) => memory.read(t, i),
    };
    const without = serverOf(new RoutingStore({ store: plain, routes: {} }));
    expect(await without.interactions()).not.toContain('transaction');
  });

  it('merges the histories of its stores, newest first, a page at a time', async () => {
    const main = new MemoryStore();
    const patients = new MemoryStore();
    const store = new RoutingStore({
      store: main,
      routes: { Patient: patients },
    });
    const write = (target: FhirStore, type: string, id: string) =>
      target.update!(type, id, {
        resourceType: type,
        id,
        ...(type === 'Observation'
          ? { status: 'final', code: { text: 'x' } }
          : {}),
      });
    // interleaved in time, so that a merge must sort
    await write(store, 'Patient', 'p1');
    await new Promise(r => setTimeout(r, 2));
    await write(store, 'Observation', 'o1');
    await new Promise(r => setTimeout(r, 2));
    await write(store, 'Patient', 'p2');
    await new Promise(r => setTimeout(r, 2));
    await write(store, 'Observation', 'o2');
    const page = (offset: number, count: number) =>
      store.history(undefined, undefined, { count, offset });
    const all = await page(0, 10);
    expect(all.total).toBe(4);
    expect(all.items.map(v => v.id)).toEqual(['o2', 'p2', 'o1', 'p1']);
    expect((await page(1, 2)).items.map(v => v.id)).toEqual(['p2', 'o1']);
    const { send, interactions } = serverOf(store);
    expect(await interactions()).toContain('history-system');
    expect((await send('_history?_count=3')).entry.length).toBe(3);
    // a store without history: no history of the whole server
    const plain: FhirStore = {
      capabilities: () => ({ interactions: ['read'], versions: 'none' }),
    };
    const without = serverOf(
      new RoutingStore({ store: main, routes: { Patient: plain } }),
    );
    expect(await without.interactions()).not.toContain('history-system');
    expect(await without.send('_history')).toBe(
      '405 history is not supported for the server',
    );
  });
});
