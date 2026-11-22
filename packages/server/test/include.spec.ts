import { FhirContext } from '@fhirjs/core';
import { r4Model } from '@fhirjs/r4';
import { expect } from 'expect';
import {
  type FhirAuthorizer,
  type FhirServerOptions,
  type FhirStore,
  FhirServer,
  MemoryStore,
  RoutingStore,
} from '../src/index.js';

const fhir = new FhirContext(r4Model);

const RESOURCES = [
  { resourceType: 'Organization', id: 'acme', name: 'Acme' },
  { resourceType: 'Organization', id: 'maker', name: 'Maker' },
  {
    resourceType: 'Patient',
    id: 'p1',
    name: [{ family: 'Ali' }],
    managingOrganization: { reference: 'Organization/acme' },
  },
  { resourceType: 'Patient', id: 'p2', name: [{ family: 'Alice' }] },
  { resourceType: 'Location', id: 'l1', name: 'Ali Ward' },
  ...[
    ['ob1', 'p1', 'x'],
    ['ob2', 'p2', 'y'],
  ].map(([id, patient, code]) => ({
    resourceType: 'Observation',
    id,
    status: 'final',
    code: { coding: [{ system: 'urn:c', code }] },
    subject: { reference: `Patient/${patient}` },
  })),
  {
    resourceType: 'Medication',
    id: 'med',
    manufacturer: { reference: 'Organization/maker' },
  },
  {
    resourceType: 'MedicationRequest',
    id: 'mr',
    status: 'active',
    intent: 'order',
    medicationReference: { reference: 'Medication/med' },
    subject: { reference: 'Patient/p1' },
  },
];

async function serverOf(options: Partial<FhirServerOptions> = {}) {
  const server = new FhirServer({ fhir, store: new MemoryStore(), ...options });
  const store = options.store ?? (server as any).options.store;
  for (const r of RESOURCES) await store.update(r.resourceType, r.id, r);
  const search = async (path: string, strict = false) => {
    const r = await server.handle(
      new Request(`http://localhost/${path}`, {
        headers: strict ? { Prefer: 'handling=strict' } : {},
      }),
    );
    const body = await r.json();
    if (r.status !== 200) return `${r.status} ${body.issue[0].diagnostics}`;
    return {
      ids: (body.entry ?? [])
        .map(
          (e: any) =>
            `${e.search.mode === 'match' ? '' : `${e.search.mode}:`}${e.resource.resourceType === 'OperationOutcome' ? 'outcome' : e.resource.id}`,
        )
        .join(','),
      self: body.link[0].url as string,
    };
  };
  const ids = async (path: string) => {
    const r = await search(path);
    return typeof r === 'string' ? r : r.ids;
  };
  return { server, search, ids };
}

describe('FhirServer: chained search', () => {
  it('follows chains and reverse chains, in the store', async () => {
    const { ids } = await serverOf();
    expect(await ids('Observation?subject:Patient.name=ali')).toBe('ob1,ob2');
    expect(await ids('Observation?subject:Patient.name:exact=Ali')).toBe('ob1');
    // patient refers to Patient only: no type needed
    expect(await ids('Observation?patient.name=alice')).toBe('ob2');
    // two links
    expect(
      await ids('Observation?subject:Patient.organization.name=acme'),
    ).toBe('ob1');
    expect(await ids('Patient?_has:Observation:patient:code=urn:c|y')).toBe(
      'p2',
    );
    expect(
      await ids(
        'Organization?_has:Patient:organization:_has:Observation:patient:code=x',
      ),
    ).toBe('acme');
    // a chain ending in a reverse chain
    expect(
      await ids(
        'Observation?patient:Patient._has:MedicationRequest:subject:status=active',
      ),
    ).toBe('ob1');
  });

  it('refuses chains it cannot follow', async () => {
    const { search } = await serverOf();
    expect(await search('Observation?subject.name=ali')).toBe(
      '400 subject.name: Observation.subject refers to Patient, Location; name the type, as subject:Patient.name',
    );
    expect(await search('Observation?subject:Medication.code=x')).toBe(
      '400 subject:Medication.code: Observation.subject does not refer to Medication',
    );
    expect(
      await search(
        'Observation?subject:Patient.organization.partof.partof.name=x',
        true,
      ),
    ).toBe(
      '400 subject:Patient.organization.partof.partof.name: a chain has 3 links at most',
    );
    expect(await search('Patient?_has:Observation=x')).toBe(
      '400 _has:Observation: _has takes _has:[type]:[parameter]:[criterion]',
    );
  });

  it('takes a chain as an unknown parameter when the store cannot answer it', async () => {
    const memory = new MemoryStore();
    const plain: FhirStore = Object.assign(Object.create(memory), {
      capabilities: () => ({ ...memory.capabilities(), chains: false }),
    });
    const { search } = await serverOf({ store: plain });
    const r = await search('Observation?patient.name=ali&code=urn:c|x');
    expect(r).toMatchObject({ ids: 'ob1' });
    expect((r as any).self).not.toContain('patient.name');
    expect(await search('Observation?patient.name=ali', true)).toBe(
      '400 patient.name: the store of Observation does not answer chained parameters',
    );
    // Organization in a store of its own: chains stop at its store
    const two = await serverOf({
      store: new RoutingStore({
        store: new MemoryStore(),
        routes: { Organization: new MemoryStore() },
      }),
    });
    expect(await two.ids('Observation?subject:Patient.name=ali')).toBe(
      'ob1,ob2',
    );
    expect(
      await two.search(
        'Observation?subject:Patient.organization.name=acme',
        true,
      ),
    ).toBe(
      '400 subject:Patient.organization.name: the store of Patient does not answer chains to Organization',
    );
  });

  it("authorizes the chain's type as a search, with its criteria", async () => {
    const onlyP1: FhirAuthorizer = {
      async authorize(access) {
        if (access.type === 'Organization')
          return { allowed: false, reason: 'No organizations' };
        return access.type === 'Patient' && access.interaction === 'search'
          ? { allowed: true, criteria: '_id=p1' }
          : { allowed: true };
      },
    };
    const { search, ids } = await serverOf({
      security: { authenticators: [], anonymous: true, authorizer: onlyP1 },
    });
    expect(await ids('Observation?subject:Patient.name=ali')).toBe('ob1');
    expect(
      await search('Observation?subject:Patient.organization.name=acme'),
    ).toBe('403 No organizations');
  });
});

describe('FhirServer: _include and _revinclude', () => {
  it('adds the resources the matches refer to, and those that refer to them', async () => {
    const { search, ids } = await serverOf();
    const r = await search('Observation?code=x&_include=Observation:subject');
    expect(r).toMatchObject({ ids: 'ob1,include:p1' });
    expect((r as any).self).toContain('_include=Observation%3Asubject');
    expect(await ids('Observation?_include=Observation:subject:Group')).toBe(
      'ob1,ob2',
    );
    expect(
      await ids(
        'Patient?_id=p1&_revinclude=Observation:subject&_revinclude=MedicationRequest:subject',
      ),
    ).toBe('p1,include:ob1,include:mr');
    // each resource once
    expect(
      await ids(
        'Observation?_include=Observation:subject&_include=Observation:patient',
      ),
    ).toBe('ob1,ob2,include:p1,include:p2');
    expect(
      await ids(
        'Patient?_id=p1&_revinclude=Observation:subject&_revinclude=Observation:patient',
      ),
    ).toBe('p1,include:ob1');
  });

  it('follows :iterate from the included resources', async () => {
    const { ids } = await serverOf();
    expect(
      await ids(
        'MedicationRequest?_include=MedicationRequest:medication&_include=Medication:manufacturer',
      ),
    ).toBe('mr,include:med');
    expect(
      await ids(
        'MedicationRequest?_include=MedicationRequest:medication&_include:iterate=Medication:manufacturer',
      ),
    ).toBe('mr,include:med,include:maker');
    expect(
      await ids(
        'Organization?name=acme&_revinclude=Patient:organization&_revinclude:iterate=Observation:subject',
      ),
    ).toBe('acme,include:p1,include:ob1');
  });

  it('refuses what it cannot include when strict, and leaves it out otherwise', async () => {
    const { search } = await serverOf();
    expect(await search('Patient?_include=Patient:name', true)).toBe(
      '400 _include=Patient:name: Patient has no reference parameter name',
    );
    expect(await search('Patient?_include=*', true)).toBe(
      '400 _include=*: it takes [type]:[parameter] or [type]:[parameter]:[target type]',
    );
    expect(
      await search('Patient?_include:recurse=Patient:organization', true),
    ).toBe('400 _include:recurse: the modifier is not supported');
    const r = await search('Patient?_id=p1&_include=Patient:name');
    expect(r).toEqual({
      ids: 'p1',
      self: 'http://localhost/Patient?_id=p1&_count=50',
    });
  });

  it('leaves out what the caller may not see, and says when there are more than it gives', async () => {
    const hideP2: FhirAuthorizer = {
      async authorize() {
        return { allowed: true };
      },
      async authorizeResource(_access, resource) {
        return resource.id !== 'p2';
      },
    };
    const { ids } = await serverOf({
      security: { authenticators: [], anonymous: true, authorizer: hideP2 },
      maxIncludes: 1,
    });
    // the matches are the search's; an included p2 is left out
    expect(await ids('Observation?_include=Observation:subject')).toBe(
      'ob1,ob2,include:p1',
    );
    expect(
      await ids(
        'Patient?_id=p1&_revinclude=Observation:subject&_revinclude=MedicationRequest:subject',
      ),
    ).toBe('p1,include:ob1,outcome:outcome');
  });
});
