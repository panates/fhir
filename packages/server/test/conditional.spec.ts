import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FhirClient } from '@fhirjs/client';
import { FhirContext, FhirElement, FhirProfile } from '@fhirjs/core';
import { Patient, r4Model } from '@fhirjs/r4';
import { expect } from 'expect';
import { FhirServer, MemoryStore, nodeListener } from '../src/index.js';

const SYS = 'urn:test';
const PROFILE = 'http://example.org/fhir/StructureDefinition/birth-patient';

/** A profile that requires a birth date, for $validate */
@FhirProfile({ url: PROFILE })
class BirthPatient extends Patient {
  @FhirElement({ min: 1 })
  declare birthDate: string;
}

const fhir = new FhirContext(r4Model, { types: [BirthPatient] });

describe('FhirServer: conditional interactions, PATCH, $validate', () => {
  let base: string;
  let client: FhirClient;
  let stop: () => Promise<void>;

  before(async () => {
    const server = new FhirServer({
      fhir,
      store: new MemoryStore(),
      base: '/fhir',
    });
    const httpServer = http.createServer(nodeListener(server));
    await new Promise<void>(r => httpServer.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/fhir`;
    client = new FhirClient({ baseUrl: base, fhir });
    stop = () => new Promise<void>(r => httpServer.close(() => r()));
  });
  after(() => stop());

  const req = (
    path: string,
    method: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${base}/${path}`, {
      method,
      headers:
        body === undefined
          ? headers
          : { 'Content-Type': 'application/fhir+json', ...headers },
      body:
        body === undefined
          ? undefined
          : typeof body === 'string'
            ? body
            : JSON.stringify(body),
    });
  const patch = (
    path: string,
    ops: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${base}/${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json', ...headers },
      body: typeof ops === 'string' ? ops : JSON.stringify(ops),
    });
  const outcome = async (r: Response) => {
    const json = await r.json();
    return `${r.status} ${json.issue.map((i: any) => i.diagnostics).join('; ')}`;
  };
  const patient = (value: string, extra: object = {}) => ({
    resourceType: 'Patient',
    identifier: [{ system: SYS, value }],
    ...extra,
  });
  const versions = async (type: string, id: string) =>
    (await (await req(`${type}/${id}/_history`, 'GET')).json()).total;

  describe('conditional create (If-None-Exist)', () => {
    it('creates when the criteria find nothing, and gives back the one they find', async () => {
      const first = await req('Patient', 'POST', patient('c1'), {
        'If-None-Exist': `identifier=${SYS}|c1`,
      });
      expect(first.status).toBe(201);
      const created = await first.json();
      const second = await req(
        'Patient',
        'POST',
        patient('c1', { active: true }),
        { 'If-None-Exist': `identifier=${SYS}|c1` },
      );
      expect(second.status).toBe(200);
      const found = await second.json();
      expect(found.id).toBe(created.id);
      expect(found.active).toBeUndefined();
      expect(await versions('Patient', created.id)).toBe(1);
      // through the client
      const again = await client.create(new Patient(patient('c1')), {
        ifNoneExist: { identifier: `${SYS}|c1` },
      });
      expect(again.id).toBe(created.id);
    });

    it('refuses criteria that find more than one (412) and unknown parameters (400)', async () => {
      await req('Patient', 'POST', patient('c2'));
      await req('Patient', 'POST', patient('c2'));
      expect(
        await outcome(
          await req('Patient', 'POST', patient('c2'), {
            'If-None-Exist': `identifier=${SYS}|c2`,
          }),
        ),
      ).toBe(
        `412 If-None-Exist: identifier=${SYS}|c2 finds more than one Patient`,
      );
      expect(
        await outcome(
          await req('Patient', 'POST', patient('c3'), {
            'If-None-Exist': 'foo=1',
          }),
        ),
      ).toBe('400 Unknown search parameter foo for Patient');
      expect(
        await outcome(
          await req('Patient', 'POST', patient('c3'), { 'If-None-Exist': '' }),
        ),
      ).toBe('400 Conditional create needs search criteria');
    });
  });

  describe('conditional update (PUT [type]?criteria)', () => {
    it('creates when nothing matches, then updates the one that does', async () => {
      const r1 = await req(
        `Patient?identifier=${SYS}|u1`,
        'PUT',
        patient('u1'),
      );
      expect(r1.status).toBe(201);
      const created = await r1.json();
      const r2 = await req(
        `Patient?identifier=${SYS}|u1`,
        'PUT',
        patient('u1', { active: true }),
      );
      expect(r2.status).toBe(200);
      const updated = await r2.json();
      expect(updated).toMatchObject({
        id: created.id,
        active: true,
        meta: { versionId: '2' },
      });
      // through the client
      const p = await client.update(
        new Patient(patient('u1', { active: false })),
        { where: { identifier: `${SYS}|u1` } },
      );
      expect(p.meta!.versionId).toBe('3');
    });

    it('creates with the id of the body when nothing matches', async () => {
      const r = await req(
        `Patient?identifier=${SYS}|u2`,
        'PUT',
        patient('u2', { id: 'given-u2' }),
      );
      expect(r.status).toBe(201);
      expect(r.headers.get('Location')).toBe(
        `${base}/Patient/given-u2/_history/1`,
      );
    });

    it('refuses another id than the one found (400), and more than one match (412)', async () => {
      await req(`Patient?identifier=${SYS}|u3`, 'PUT', patient('u3'));
      expect(
        await outcome(
          await req(
            `Patient?identifier=${SYS}|u3`,
            'PUT',
            patient('u3', { id: 'other' }),
          ),
        ),
      ).toMatch(
        /^400 The Patient's id other is not the id of the Patient the criteria find, /,
      );
      await req('Patient', 'POST', patient('u4'));
      await req('Patient', 'POST', patient('u4'));
      expect(
        (await req(`Patient?identifier=${SYS}|u4`, 'PUT', patient('u4')))
          .status,
      ).toBe(412);
    });
  });

  describe('conditional delete (DELETE [type]?criteria)', () => {
    it('deletes the one resource found, nothing when none, refuses more than one', async () => {
      const id = (await (await req('Patient', 'POST', patient('d1'))).json())
        .id;
      expect((await req(`Patient?identifier=${SYS}|d1`, 'DELETE')).status).toBe(
        204,
      );
      expect((await req(`Patient/${id}`, 'GET')).status).toBe(410);
      expect(
        (await req(`Patient?identifier=${SYS}|none`, 'DELETE')).status,
      ).toBe(204);
      await req('Patient', 'POST', patient('d2'));
      await req('Patient', 'POST', patient('d2'));
      expect((await req(`Patient?identifier=${SYS}|d2`, 'DELETE')).status).toBe(
        412,
      );
      // through the client
      await req('Patient', 'POST', patient('d3'));
      await client.delete(Patient, { identifier: `${SYS}|d3` });
      expect(
        (await (await req(`Patient?identifier=${SYS}|d3`, 'GET')).json()).total,
      ).toBe(0);
    });
  });

  describe('PATCH (JSON Patch)', () => {
    let id: string;
    beforeEach(async () => {
      id = (
        await (
          await req(
            'Patient',
            'POST',
            patient('p', {
              name: [{ family: 'Kaya', given: ['Ali'] }],
              gender: 'male',
            }),
          )
        ).json()
      ).id;
    });

    it('applies add, remove, replace, move, copy and test, as one new version', async () => {
      const r = await patch(`Patient/${id}`, [
        { op: 'test', path: '/gender', value: 'male' },
        { op: 'replace', path: '/name/0/family', value: 'Kaya-Demir' },
        { op: 'add', path: '/name/0/given/-', value: 'Veli' },
        {
          op: 'add',
          path: '/telecom',
          value: [{ system: 'phone', value: '555' }],
        },
        { op: 'copy', from: '/name/0', path: '/name/-' },
        { op: 'move', from: '/name/1/given/0', path: '/name/1/given/-' },
        { op: 'remove', path: '/gender' },
      ]);
      expect(r.status).toBe(200);
      const p = await r.json();
      expect(p.meta.versionId).toBe('2');
      expect(p.name).toEqual([
        { family: 'Kaya-Demir', given: ['Ali', 'Veli'] },
        { family: 'Kaya-Demir', given: ['Veli', 'Ali'] },
      ]);
      expect(p.telecom).toEqual([{ system: 'phone', value: '555' }]);
      expect(p.gender).toBeUndefined();
      // through the client
      const q = await client.patch(
        Patient,
        id,
        [{ op: 'replace', path: '/active', value: true }].map(o => ({
          ...o,
          op: 'add' as const,
        })),
      );
      expect(q.active).toBe(true);
    });

    it('keeps the places of decimals, those it leaves and those it writes', async () => {
      const oid = (
        await (
          await req(
            'Observation',
            'POST',
            '{"resourceType":"Observation","status":"final","code":{"text":"x"},"valueQuantity":{"value":1.50,"unit":"mg"},"component":[{"code":{"text":"a"},"valueQuantity":{"value":3.0}}]}',
          )
        ).json()
      ).id;
      const r1 = await patch(`Observation/${oid}`, [
        { op: 'replace', path: '/status', value: 'amended' },
      ]);
      const t1 = await r1.text();
      expect(t1).toContain('"value":1.50');
      expect(t1).toContain('"value":3.0');
      const r2 = await patch(
        `Observation/${oid}`,
        '[{"op":"replace","path":"/valueQuantity/value","value":2.50}]',
      );
      expect(await r2.text()).toContain('"value":2.50');
    });

    it('patches the one resource criteria find, and checks If-Match', async () => {
      const r = await patch(`Patient?identifier=${SYS}|solo`, [
        { op: 'add', path: '/active', value: true },
      ]);
      expect(r.status).toBe(404);
      const sid = (await (await req('Patient', 'POST', patient('solo'))).json())
        .id;
      const ok = await patch(`Patient?identifier=${SYS}|solo`, [
        { op: 'add', path: '/active', value: true },
      ]);
      expect((await ok.json()).id).toBe(sid);
      expect(
        (
          await patch(
            `Patient/${sid}`,
            [{ op: 'add', path: '/active', value: false }],
            { 'If-Match': 'W/"1"' },
          )
        ).status,
      ).toBe(412);
      expect(
        (
          await patch(
            `Patient/${sid}`,
            [{ op: 'add', path: '/active', value: false }],
            { 'If-Match': 'W/"2"' },
          )
        ).status,
      ).toBe(200);
    });

    it('refuses what it cannot apply, and what the model does not take', async () => {
      const answers = [
        await patch(`Patient/${id}`, { op: 'add' }),
        await patch(`Patient/${id}`, [{ op: 'jump', path: '/a' }]),
        await patch(`Patient/${id}`, [{ op: 'add', path: 'name', value: 1 }]),
        await patch(`Patient/${id}`, [{ op: 'remove', path: '/birthDate' }]),
        await patch(`Patient/${id}`, [
          { op: 'test', path: '/gender', value: 'female' },
        ]),
        await patch(`Patient/${id}`, [
          { op: 'replace', path: '/id', value: 'other' },
        ]),
        await patch(`Patient/${id}`, 'not json'),
        await fetch(`${base}/Patient/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: '[]',
        }),
      ];
      expect(await Promise.all(answers.map(outcome))).toEqual([
        '400 A JSON Patch is an array of operations',
        '400 Patch operation 0: "jump" is not an operation',
        '400 Patch operation 0: "name" is not a JSON Pointer',
        '422 Patch operation 0 (remove /birthDate): /birthDate is not there',
        '422 Patch operation 0 (test /gender): the value is not the one the test expects',
        `422 The patch must leave a Patient with the id ${id}`,
        '400 The patch is not JSON',
        '415 A patch is sent as application/json-patch+json, not application/json',
      ]);
      const invalid = await patch(`Patient/${id}`, [
        { op: 'replace', path: '/gender', value: 'unknown-value' },
      ]);
      expect(invalid.status).toBe(422);
      expect((await invalid.json()).issue[0].expression).toEqual([
        'Patient.gender',
      ]);
      // nothing written by the refused patches
      expect(await versions('Patient', id)).toBe(1);
      await req(`Patient/${id}`, 'DELETE');
      expect(
        (
          await patch(`Patient/${id}`, [
            { op: 'add', path: '/active', value: true },
          ])
        ).status,
      ).toBe(410);
    });
  });

  describe('$validate', () => {
    it('gives the issues of a resource, stores nothing, and checks a profile asked for', async () => {
      const valid = await req('Patient/$validate', 'POST', patient('v1'));
      expect(valid.status).toBe(200);
      // a warning only: it has no narrative (dom-6)
      expect(
        (await valid.json()).issue.map((i: any) => [i.severity, i.diagnostics]),
      ).toEqual([
        [
          'warning',
          'dom-6: A resource should have narrative for robust management',
        ],
      ]);
      const invalid = await (
        await req(
          'Patient/$validate',
          'POST',
          patient('v1', { gender: 'unknown-value' }),
        )
      ).json();
      expect(
        invalid.issue.map((i: any) => [i.severity, i.expression[0]]),
      ).toEqual([
        ['error', 'Patient.gender'],
        ['warning', 'Patient'],
      ]);
      expect(
        (await (await req(`Patient?identifier=${SYS}|v1`, 'GET')).json()).total,
      ).toBe(0);
      // a profile, by the URL or in a Parameters
      const byUrl = await (
        await req(`Patient/$validate?profile=${PROFILE}`, 'POST', patient('v1'))
      ).json();
      expect(
        byUrl.issue.some(
          (i: any) =>
            i.severity === 'error' &&
            /birthDate/.test(i.expression?.[0] ?? i.diagnostics),
        ),
      ).toBe(true);
      const byParameters = await (
        await req('Patient/$validate', 'POST', {
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'resource',
              resource: patient('v1', { birthDate: '2000-01-01' }),
            },
            { name: 'profile', valueUri: PROFILE },
          ],
        })
      ).json();
      expect(
        byParameters.issue.filter((i: any) => i.severity === 'error'),
      ).toEqual([]);
    });

    it('refuses what it cannot validate', async () => {
      expect(
        await outcome(
          await req('Patient/$validate', 'POST', {
            resourceType: 'Observation',
          }),
        ),
      ).toBe(
        '400 $validate takes a Patient, or a Parameters with a Patient as resource',
      );
      expect(
        await outcome(
          await req(
            'Patient/$validate?profile=http://nowhere/p',
            'POST',
            patient('v2'),
          ),
        ),
      ).toBe('400 profile: http://nowhere/p is not known to the server');
      expect(await outcome(await req('Patient/$validate', 'GET'))).toBe(
        '405 GET is not supported on Patient/$validate',
      );
    });
  });

  it('says what it supports in the CapabilityStatement', async () => {
    const cs = await client.capabilities();
    const p = cs.rest[0].resource.find((r: any) => r.type === 'Patient');
    expect(p).toMatchObject({
      conditionalCreate: true,
      conditionalUpdate: true,
      conditionalDelete: 'single',
      operation: [
        {
          name: 'validate',
          definition:
            'http://hl7.org/fhir/OperationDefinition/Resource-validate',
        },
      ],
    });
    expect(p.interaction.map((i: any) => i.code)).toContain('patch');
    expect(fhir.validate(cs).valid).toBe(true);
  });
});

describe('FhirServer: conditional interactions need a store that searches', () => {
  it('answers 405 and says so in the CapabilityStatement', async () => {
    const store = new MemoryStore();
    const caps = store.capabilities();
    store.capabilities = () => ({
      ...caps,
      interactions: caps.interactions.filter(i => i !== 'search'),
    });
    const server = new FhirServer({ fhir, store, resources: ['Patient'] });
    const r = await server.handle(
      new Request('http://localhost/Patient', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/fhir+json',
          'If-None-Exist': 'identifier=x',
        },
        body: '{"resourceType":"Patient"}',
      }),
    );
    expect(r.status).toBe(405);
    expect((await r.json()).issue[0].diagnostics).toBe(
      'Conditional create is not supported for Patient: its store cannot search',
    );
    const p =
      server.capabilityStatement('http://localhost').rest[0].resource[0];
    expect(p).toMatchObject({
      conditionalCreate: false,
      conditionalUpdate: false,
      conditionalDelete: 'not-supported',
    });
  });
});
