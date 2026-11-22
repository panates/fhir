import { FhirContext } from '@fhirjs/core';
import { r4Model } from '@fhirjs/r4';
import { r5Model as r5 } from '@fhirjs/r5';
import { expect } from 'expect';
import {
  type FhirAuthenticator,
  type FhirAuthorizer,
  type FhirPrincipal,
  FhirServer,
  MemoryStore,
  SmartAuthorizer,
} from '../src/index.js';

const fhir = new FhirContext(r4Model);

/** The caller, from a test header: the scopes, and the patient in context */
const fromHeader: FhirAuthenticator = {
  async authenticate(request) {
    const h = request.headers.get('X-Test-Principal');
    if (!h) return;
    const { scopes, patient } = JSON.parse(h);
    const p: FhirPrincipal = {
      subject: 'u',
      method: 'test',
      scopes: scopes.split(' '),
      claims: {},
    };
    if (patient) p.patient = patient;
    return p;
  },
};

const RESOURCES = [
  { resourceType: 'Patient', id: 'p1' },
  { resourceType: 'Patient', id: 'p2' },
  {
    resourceType: 'Observation',
    id: 'o1',
    status: 'final',
    code: { text: 'a' },
    subject: { reference: 'Patient/p1' },
  },
  {
    resourceType: 'Observation',
    id: 'o2',
    status: 'final',
    code: { text: 'b' },
    subject: { reference: 'Patient/p2' },
  },
  {
    resourceType: 'Observation',
    id: 'o3',
    status: 'final',
    category: [
      {
        coding: [
          {
            system:
              'http://terminology.hl7.org/CodeSystem/observation-category',
            code: 'laboratory',
          },
        ],
      },
    ],
    code: { text: 'c' },
    subject: { reference: 'Patient/p1' },
  },
  // in p1's compartment by performer only
  {
    resourceType: 'Observation',
    id: 'o4',
    status: 'final',
    code: { text: 'd' },
    subject: { reference: 'Patient/p2' },
    performer: [{ reference: 'Patient/p1' }],
  },
  {
    resourceType: 'Encounter',
    id: 'e1',
    status: 'finished',
    class: { code: 'AMB' },
    subject: { reference: 'Patient/p1' },
  },
  { resourceType: 'Medication', id: 'm1' },
];

async function serverWith(user?: FhirAuthorizer) {
  const server = new FhirServer({
    fhir,
    store: new MemoryStore(),
    security: {
      authenticators: [fromHeader],
      authorizer: new SmartAuthorizer({ fhir, user }),
    },
  });
  const all = JSON.stringify({ scopes: 'system/*.cruds' });
  for (const r of RESOURCES)
    await server.handle(
      new Request(`http://localhost/${r.resourceType}/${r.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/fhir+json',
          'X-Test-Principal': all,
        },
        body: JSON.stringify(r),
      }),
    );
  return server;
}

describe('SmartAuthorizer', () => {
  let server: FhirServer;
  before(async () => (server = await serverWith()));

  const as = (scopes: string, patient?: string) => ({
    'X-Test-Principal': JSON.stringify({ scopes, patient }),
  });
  const get = (path: string, headers: Record<string, string>) =>
    server.handle(new Request(`http://localhost/${path}`, { headers }));
  const ids = async (path: string, headers: Record<string, string>) => {
    const r = await get(path, headers);
    if (r.status !== 200) return `${r.status}`;
    return ((await r.json()).entry ?? [])
      .map((e: any) => e.resource.id)
      .sort()
      .join(',');
  };
  const write = (
    method: string,
    path: string,
    body: object,
    headers: Record<string, string>,
  ) =>
    server.handle(
      new Request(`http://localhost/${path}`, {
        method,
        headers: { 'Content-Type': 'application/fhir+json', ...headers },
        body: JSON.stringify(body),
      }),
    );
  const reason = async (r: Response) =>
    `${r.status} ${(await r.json()).issue[0].diagnostics}`;

  it("keeps patient/ scopes to the patient's compartment", async () => {
    const p1 = as('patient/*.rs', 'p1');
    expect(await ids('Observation', p1)).toBe('o1,o3');
    expect(await ids('Patient', p1)).toBe('p1');
    expect(await ids('Encounter', p1)).toBe('e1');
    // a type not in the compartment is not restricted
    expect(await ids('Medication', p1)).toBe('m1');
    expect((await get('Observation/o1', p1)).status).toBe(200);
    expect((await get('Observation/o2', p1)).status).toBe(404);
    expect((await get('Patient/p2', p1)).status).toBe(404);
    // a read takes every parameter of the compartment: o4 is p1's by performer
    expect((await get('Observation/o4', p1)).status).toBe(200);
  });

  it("restricts by a v2 scope's query", async () => {
    const lab = as('patient/Observation.rs?category=laboratory', 'p1');
    expect(await ids('Observation', lab)).toBe('o3');
    expect((await get('Observation/o1', lab)).status).toBe(404);
    expect(await reason(await get('Patient', lab))).toBe(
      '403 The scopes do not grant s on Patient',
    );
    // with a broader scope too, the broader one is taken
    expect(
      await ids(
        'Observation',
        as(
          'patient/Observation.rs?category=laboratory patient/Observation.rs',
          'p1',
        ),
      ),
    ).toBe('o1,o3');
  });

  it('reads v1 scopes, and needs the permission each interaction takes', async () => {
    // on a server of its own: it writes
    server = await serverWith();
    const read = as('patient/*.read', 'p1');
    expect(await ids('Observation', read)).toBe('o1,o3');
    const obs = {
      resourceType: 'Observation',
      status: 'final',
      code: { text: 'n' },
    };
    expect(
      await reason(
        await write(
          'POST',
          'Observation',
          { ...obs, subject: { reference: 'Patient/p1' } },
          read,
        ),
      ),
    ).toBe('403 The scopes do not grant c on Observation');
    const writer = as('patient/Observation.write', 'p1');
    expect(
      (
        await write(
          'POST',
          'Observation',
          { ...obs, subject: { reference: 'Patient/p1' } },
          writer,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await write(
          'POST',
          'Observation',
          { ...obs, subject: { reference: 'Patient/p2' } },
          writer,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await write(
          'PUT',
          'Observation/o2',
          { ...obs, id: 'o2', subject: { reference: 'Patient/p1' } },
          writer,
        )
      ).status,
    ).toBe(404);
    expect(await reason(await get('Observation/o1', writer))).toBe(
      '403 The scopes do not grant r on Observation',
    );
  });

  it('gives system/ scopes what they name, on every resource', async () => {
    server = await serverWith();
    expect(await ids('Observation', as('system/*.rs'))).toBe('o1,o2,o3,o4');
    const readPatient = as('system/Patient.r');
    expect((await get('Patient/p2', readPatient)).status).toBe(200);
    expect(await reason(await get('Patient', readPatient))).toBe(
      '403 The scopes do not grant s on Patient',
    );
    expect((await get('Observation/o1', readPatient)).status).toBe(403);
    expect((await get('_history', as('system/*.r'))).status).toBe(200);
    expect(await reason(await get('_history', as('patient/*.rs', 'p1')))).toBe(
      '403 The scopes do not grant history of the whole server',
    );
  });

  it('refuses patient/ scopes without a patient, and callers without scopes', async () => {
    expect(await reason(await get('Observation', as('patient/*.rs')))).toBe(
      '403 patient/ scopes need a patient in context',
    );
    expect(await reason(await get('Observation', as('openid fhirUser')))).toBe(
      '403 The scopes do not grant s on Observation',
    );
  });

  it('asks the user/ rules after the scope, and grants what it names when there are none', async () => {
    expect(await ids('Patient', as('user/*.rs'))).toBe('p1,p2');
    // a practitioner who sees p1 only
    const onlyP1: FhirAuthorizer = {
      async authorize(access) {
        return access.interaction === 'search' && access.type === 'Patient'
          ? { allowed: true, criteria: '_id=p1' }
          : { allowed: true };
      },
      async authorizeResource(_access, resource) {
        return resource.resourceType !== 'Patient' || resource.id === 'p1';
      },
    };
    const s = await serverWith(onlyP1);
    const headers = as('user/*.rs');
    const r = await s.handle(
      new Request('http://localhost/Patient', { headers }),
    );
    expect(
      ((await r.json()).entry ?? []).map((e: any) => e.resource.id),
    ).toEqual(['p1']);
    expect(
      (await s.handle(new Request('http://localhost/Patient/p2', { headers })))
        .status,
    ).toBe(404);
    expect(
      (await s.handle(new Request('http://localhost/Patient/p1', { headers })))
        .status,
    ).toBe(200);
  });
});

describe('Compartments of the model', () => {
  it('gives the parameters that put a type in a compartment', () => {
    expect(r4Model.compartmentParams('Patient', 'Observation')).toEqual([
      'subject',
      'performer',
    ]);
    expect(r4Model.compartmentParams('Patient', 'Medication')).toBeUndefined();
    expect(r4Model.compartments().sort()).toEqual([
      'Device',
      'Encounter',
      'Patient',
      'Practitioner',
      'RelatedPerson',
    ]);
    expect(r5.compartmentParams('Patient', 'Encounter')).toEqual(['patient']);
    // the models a context makes keep them
    expect(
      new FhirContext(r4Model, { types: [] }).model.compartmentParams(
        'Patient',
        'Encounter',
      ),
    ).toEqual(['patient']);
  });

  it('names only search parameters the model has', () => {
    for (const model of [r4Model, r5]) {
      const missing: string[] = [];
      for (const c of model.compartments())
        for (const type of model.resourceTypes())
          for (const code of model.compartmentParams(c, type) ?? [])
            if (!model.getSearchParameter(type, code))
              missing.push(`${c}:${type}.${code}`);
      expect(missing).toEqual([]);
    }
  });
});
