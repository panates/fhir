/**
 * SqlStore's writes, through a server: create, update and delete map a
 * resource to a row with the table's row(), and the store refuses what the
 * row does not keep. A table with a lastUpdated column has versions
 * (If-Match), one without has none, one without row() is read-only. Needs
 * PostgreSQL: FHIR_PG_URL; skipped without it.
 */
import '@sqb/postgres';
import { FhirContext } from '@fhirjs/core';
import { r4Model } from '@fhirjs/r4';
import { FhirServer, FhirServerError } from '@fhirjs/server';
import { SqbClient } from '@sqb/connect';
import { expect } from 'expect';
import {
  code,
  decimalValue,
  lostElements,
  onlyElements,
  reference,
  referenceId,
  SqlStore,
  string,
  token,
} from '../src/index.js';

const fhir = new FhirContext(r4Model);
const URL_ = process.env.FHIR_PG_URL;
const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';
const NATIONAL_ID = 'urn:example:national-id';
const VITAL_SIGNS =
  'http://terminology.hl7.org/CodeSystem/observation-category';
const SEX: Record<string, string> = {
  '1': 'male',
  '2': 'female',
  '9': 'other',
};
const SEX_CODE = Object.fromEntries(
  Object.entries(SEX).map(([k, v]) => [v, k]),
);

const DDL = [
  `create table persons (
     person_id bigint generated always as identity primary key,
     national_id text unique, family_name text not null, given_name text,
     sex text check (sex in ('1', '2', '9')), born date, died_at timestamptz,
     changed timestamptz not null default now())`,
  `create table vital_kinds (kind_id int primary key, loinc text not null unique, label text not null)`,
  // no column of when a row changed: no versions
  `create table vitals (
     vital_id bigint generated always as identity primary key,
     person_id bigint not null references persons,
     kind_id int not null references vital_kinds, measured_at timestamptz,
     value numeric(6, 2))`,
  `create table wards (ward_id int primary key, name text not null)`,
  `insert into vital_kinds values (1, '8480-6', 'Systolic'), (2, '8462-4', 'Diastolic')`,
  `insert into wards values (1, 'Cardiology')`,
];

const instantText = (e: string) =>
  `to_char(${e} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const compact = (o: Record<string, any>) => {
  for (const k of Object.keys(o)) if (o[k] == null) delete o[k];
  return o;
};

const store = (client: SqbClient) =>
  new SqlStore({
    client,
    types: {
      Patient: {
        table: 'persons',
        id: 'person_id',
        lastUpdated: 'changed',
        select: a => `${a}.person_id::text as id, ${a}.national_id,
          ${a}.family_name, ${a}.given_name, ${a}.sex, ${a}.born::text as born,
          ${instantText(`${a}.died_at`)} as died_at,
          ${instantText(`${a}.changed`)} as changed`,
        resource: r =>
          compact({
            resourceType: 'Patient',
            id: r.id,
            meta: { lastUpdated: r.changed },
            identifier: r.national_id
              ? [{ system: NATIONAL_ID, value: r.national_id }]
              : undefined,
            name: [
              compact({
                family: r.family_name,
                given: r.given_name ? [r.given_name] : undefined,
              }),
            ],
            gender: r.sex ? SEX[r.sex] : undefined,
            birthDate: r.born,
            deceasedDateTime: r.died_at,
          }),
        row: r => {
          onlyElements(r, [
            'identifier',
            'name',
            'gender',
            'birthDate',
            'deceasedDateTime',
          ]);
          return {
            national_id:
              r.identifier?.find((i: any) => i.system === NATIONAL_ID)?.value ??
              null,
            family_name: r.name?.[0]?.family ?? null,
            given_name: r.name?.[0]?.given?.[0] ?? null,
            sex: SEX_CODE[r.gender] ?? null,
            born: r.birthDate ?? null,
            died_at: r.deceasedDateTime ?? null,
          };
        },
        params: {
          identifier: token(code('national_id', { system: NATIONAL_ID })),
          family: string('family_name'),
          gender: token(code('sex', { map: SEX })),
        },
      },
      Observation: {
        table: 'vitals',
        id: 'vital_id',
        select: a => `${a}.vital_id::text as id, ${a}.person_id::text as person,
          (select k.loinc from vital_kinds k where k.kind_id = ${a}.kind_id) as loinc,
          (select k.label from vital_kinds k where k.kind_id = ${a}.kind_id) as label,
          ${instantText(`${a}.measured_at`)} as measured_at, ${a}.value::float8 as value`,
        resource: r =>
          compact({
            resourceType: 'Observation',
            id: r.id,
            status: 'final',
            category: [
              { coding: [{ system: VITAL_SIGNS, code: 'vital-signs' }] },
            ],
            code: {
              coding: [{ system: LOINC, code: r.loinc, display: r.label }],
            },
            subject: { reference: `Patient/${r.person}` },
            effectiveDateTime: r.measured_at,
            valueQuantity:
              r.value === null
                ? undefined
                : {
                    value: r.value,
                    unit: 'mm[Hg]',
                    system: UCUM,
                    code: 'mm[Hg]',
                  },
          }),
        row: async (r, db) => {
          onlyElements(r, [
            'status',
            'category',
            'code',
            'subject',
            'effectiveDateTime',
            'valueQuantity',
          ]);
          const loinc = r.code?.coding?.find(
            (c: any) => c.system === LOINC,
          )?.code;
          const [kind] = await db.rows(
            'select kind_id from vital_kinds where loinc = :loinc',
            { loinc: loinc ?? null },
          );
          if (!kind)
            throw new FhirServerError(
              422,
              `The code of the Observation is not a vital sign the database keeps`,
              'not-supported',
            );
          return {
            person_id: referenceId(r.subject, 'Patient') ?? null,
            kind_id: kind.kind_id,
            measured_at: r.effectiveDateTime ?? null,
            value: decimalValue(r.valueQuantity?.value) ?? null,
          };
        },
        params: {
          subject: reference('person_id', 'Patient'),
          code: token(
            code(
              a =>
                `(select k.loinc from vital_kinds k where k.kind_id = ${a}.kind_id)`,
              { system: LOINC },
            ),
          ),
        },
      },
      Location: {
        table: 'wards',
        id: 'ward_id',
        select: a => `${a}.ward_id::text as id, ${a}.name`,
        resource: r => ({ resourceType: 'Location', id: r.id, name: r.name }),
      },
    },
  });

function clientOf(url: string, schema?: string): SqbClient {
  const u = new URL(url);
  return new SqbClient({
    dialect: 'postgres',
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username) || 'postgres',
    password: u.password ? decodeURIComponent(u.password) : undefined,
    database: u.pathname.slice(1) || 'postgres',
    schema,
  });
}

const ALI = {
  resourceType: 'Patient',
  identifier: [{ system: NATIONAL_ID, value: '100' }],
  name: [{ family: 'Yılmaz', given: ['Ali'] }],
  gender: 'male',
  birthDate: '1980-05-12',
};

describe('SqlStore writes', function () {
  const schema = `sqlwrites_${Math.random().toString(36).slice(2, 10)}`;
  let admin: SqbClient;
  let client: SqbClient;
  let server: FhirServer;

  before(async function () {
    if (!URL_) return this.skip();
    admin = clientOf(URL_);
    await admin.execute(
      'create extension if not exists unaccent with schema public',
    );
    await admin.execute(`create schema ${schema}`);
    await admin.acquire(async connection => {
      await connection.execute(`set search_path to ${schema}`);
      for (const s of DDL) await connection.execute(s);
    });
    client = clientOf(URL_, schema);
    server = new FhirServer({
      fhir,
      store: store(client),
      resources: ['Patient', 'Observation', 'Location'],
    });
  });

  after(async () => {
    await client?.close();
    if (admin) {
      await admin.execute(`drop schema if exists ${schema} cascade`);
      await admin.close();
    }
  });

  const send = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const r = await server.handle(
      new Request(`http://localhost/${path}`, {
        method,
        headers: {
          ...(body === undefined
            ? {}
            : { 'Content-Type': 'application/fhir+json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await r.text();
    return {
      status: r.status,
      headers: r.headers,
      body: text ? JSON.parse(text) : undefined,
    };
  };

  /** The status and the first issue's text of a refusal */
  const refusal = async (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => {
    const r = await send(method, path, body, headers);
    return `${r.status} ${r.body?.issue?.[0]?.diagnostics}`;
  };

  const count = async (table: string) =>
    (
      await client.execute(`select cast(count(*) as int) as n from ${table}`, {
        objectRows: true,
      })
    ).rows![0].n as number;

  const patient = async (resource: Record<string, any> = ALI) => {
    const r = await send('POST', 'Patient', resource);
    expect(r.status).toBe(201);
    return r.body as Record<string, any>;
  };

  it('creates a row, read back as the resource, with a version from its lastUpdated', async () => {
    const r = await send('POST', 'Patient', {
      ...ALI,
      identifier: [{ system: NATIONAL_ID, value: '1' }],
      // the same instant in another zone, read back in UTC
      deceasedDateTime: '2020-06-01T13:00:00+03:00',
    });
    expect(r.status).toBe(201);
    const { id, meta } = r.body;
    expect(meta.versionId).toBe(String(Date.parse(meta.lastUpdated)));
    expect(r.headers.get('ETag')).toBe(`W/"${meta.versionId}"`);
    expect(r.headers.get('Location')).toBe(
      `http://localhost/Patient/${id}/_history/${meta.versionId}`,
    );
    expect(r.body).toEqual({
      ...ALI,
      identifier: [{ system: NATIONAL_ID, value: '1' }],
      id,
      meta,
      deceasedDateTime: '2020-06-01T10:00:00.000Z',
    });
    expect((await send('GET', `Patient/${id}`)).body).toEqual(r.body);
    const found = await send('GET', 'Patient?identifier=1');
    expect(found.body.entry.map((e: any) => e.resource)).toEqual([r.body]);
  });

  it('creates in a table without versions, a code looked up in its own table', async () => {
    const { id } = await patient({ ...ALI, identifier: undefined });
    const r = await send('POST', 'Observation', {
      resourceType: 'Observation',
      status: 'final',
      code: { coding: [{ system: LOINC, code: '8480-6' }] },
      subject: { reference: `Patient/${id}` },
      effectiveDateTime: '2026-01-01T08:00:00.000Z',
      valueQuantity: {
        value: 120.5,
        unit: 'mm[Hg]',
        system: UCUM,
        code: 'mm[Hg]',
      },
    });
    expect(r.status).toBe(201);
    expect(r.headers.get('ETag')).toBeNull();
    expect(r.body.meta).toBeUndefined();
    expect(r.body.code.coding[0].display).toBe('Systolic');
    expect(r.headers.get('Location')).toBe(
      `http://localhost/Observation/${r.body.id}`,
    );
    const found = await send(
      'GET',
      `Observation?subject=Patient/${id}&code=8480-6`,
    );
    expect(found.body.total).toBe(1);
  });

  it('updates the row: the resource replaced, a new version, If-Match checked', async () => {
    const created = await patient({
      ...ALI,
      identifier: [{ system: NATIONAL_ID, value: '2' }],
    });
    const { id } = created;
    const v1 = created.meta.versionId;
    // without the given name: its column is set to null
    const next = {
      resourceType: 'Patient',
      id,
      name: [{ family: 'Kaya' }],
      gender: 'female',
    };
    const r = await send('PUT', `Patient/${id}`, next, {
      'If-Match': `W/"${v1}"`,
    });
    expect(r.status).toBe(200);
    const v2 = r.body.meta.versionId;
    expect(Number(v2)).toBeGreaterThan(Number(v1));
    expect(r.body).toEqual({ ...next, meta: r.body.meta });
    expect(
      await refusal('PUT', `Patient/${id}`, next, { 'If-Match': `W/"${v1}"` }),
    ).toBe(`412 If-Match: Patient/${id} is at version ${v2}, not ${v1}`);
    // every update a later version, even within one millisecond
    const now = Date.now;
    const at = now() + 60_000;
    Date.now = () => at;
    let a, b;
    try {
      a = await send('PUT', `Patient/${id}`, next);
      b = await send('PUT', `Patient/${id}`, next);
    } finally {
      Date.now = now;
    }
    expect(Number(a.body.meta.versionId)).toBe(at);
    expect(Number(b.body.meta.versionId)).toBe(at + 1);
    // an id the table does not have is not created
    expect(
      (await send('PUT', 'Patient/999999', { ...next, id: '999999' })).status,
    ).toBe(405);
  });

  it('deletes the row; refuses one other rows refer to', async () => {
    const { id, meta } = await patient({
      ...ALI,
      identifier: [{ system: NATIONAL_ID, value: '3' }],
    });
    expect(
      await refusal('DELETE', `Patient/${id}`, undefined, {
        'If-Match': 'W/"1"',
      }),
    ).toBe(
      `412 If-Match: Patient/${id} is at version ${meta.versionId}, not 1`,
    );
    expect((await send('DELETE', `Patient/${id}`)).status).toBe(204);
    expect((await send('GET', `Patient/${id}`)).status).toBe(404);
    expect((await send('DELETE', `Patient/${id}`)).status).toBe(204);

    const other = await patient({ ...ALI, identifier: undefined });
    await send('POST', 'Observation', {
      resourceType: 'Observation',
      status: 'final',
      code: { coding: [{ system: LOINC, code: '8462-4' }] },
      subject: { reference: `Patient/${other.id}` },
    });
    expect(await refusal('DELETE', `Patient/${other.id}`)).toBe(
      '409 The Patient is referred to by other rows of the database',
    );
    expect((await send('GET', `Patient/${other.id}`)).status).toBe(200);
  });

  it('refuses what the row does not keep, and writes nothing', async () => {
    const persons = await count('persons');
    const vitals = await count('vitals');
    const { id } = await patient({ ...ALI, identifier: undefined });
    const before = await count('persons');
    expect(before).toBe(persons + 1);
    const vital = {
      resourceType: 'Observation',
      status: 'final',
      code: { coding: [{ system: LOINC, code: '8480-6' }] },
      subject: { reference: `Patient/${id}` },
    };
    expect(
      Object.fromEntries(
        await Promise.all(
          Object.entries({
            // refused by row(): an element it has no column for
            photo: [
              'POST',
              'Patient',
              { ...ALI, photo: [{ url: 'http://x/1.png' }] },
            ],
            // refused by the store: what row() wrote did not come back
            secondGiven: [
              'POST',
              'Patient',
              { ...ALI, name: [{ family: 'Doe', given: ['John', 'Paul'] }] },
            ],
            otherIdentifier: [
              'POST',
              'Patient',
              { ...ALI, identifier: [{ system: 'urn:x', value: '1' }] },
            ],
            unknownGender: ['POST', 'Patient', { ...ALI, gender: 'unknown' }],
            status: [
              'POST',
              'Observation',
              { ...vital, status: 'preliminary' },
            ],
            display: [
              'POST',
              'Observation',
              {
                ...vital,
                code: {
                  coding: [{ system: LOINC, code: '8480-6', display: 'SBP' }],
                },
              },
            ],
            rounded: [
              'POST',
              'Observation',
              {
                ...vital,
                valueQuantity: {
                  value: 120.555,
                  unit: 'mm[Hg]',
                  system: UCUM,
                  code: 'mm[Hg]',
                },
              },
            ],
            // refused by the database
            noFamily: [
              'POST',
              'Patient',
              { ...ALI, name: [{ given: ['Ali'] }] },
            ],
            partialDate: ['POST', 'Patient', { ...ALI, birthDate: '1980' }],
            duplicate: [
              'POST',
              'Patient',
              { ...ALI, identifier: [{ system: NATIONAL_ID, value: '1' }] },
            ],
            noPatient: [
              'POST',
              'Observation',
              { ...vital, subject: { reference: 'Patient/999999' } },
            ],
            // refused by row()'s own checks
            otherCode: [
              'POST',
              'Observation',
              {
                ...vital,
                code: { coding: [{ system: LOINC, code: '718-7' }] },
              },
            ],
            group: [
              'POST',
              'Observation',
              { ...vital, subject: { reference: 'Group/1' } },
            ],
            update: [
              'PUT',
              `Patient/${id}`,
              {
                ...ALI,
                id,
                name: [{ family: 'Doe', given: ['John', 'Paul'] }],
              },
            ],
          }).map(async ([k, [method, path, body]]) => [
            k,
            await refusal(method as string, path as string, body),
          ]),
        ),
      ),
    ).toEqual({
      photo:
        '422 The Patient has elements the table has no column for: Patient.photo',
      secondGiven:
        '422 The Patient has elements the database does not keep: Patient.name[0]',
      otherIdentifier:
        '422 The Patient has elements the database does not keep: Patient.identifier',
      unknownGender:
        '422 The Patient has elements the database does not keep: Patient.gender',
      status:
        '422 The Observation has elements the database does not keep: Observation.status',
      display:
        '422 The Observation has elements the database does not keep: Observation.code.coding[0]',
      rounded:
        '422 The Observation has elements the database does not keep: Observation.valueQuantity.value',
      noFamily: '422 The database refused a value of the Patient',
      partialDate: '422 The database refused a value of the Patient',
      duplicate: '409 A Patient with the same unique value exists',
      noPatient:
        '422 The Observation refers to a row the database does not have',
      otherCode:
        '422 The code of the Observation is not a vital sign the database keeps',
      group: '422 The reference Group/1 is not to a Patient of this server',
      update:
        '422 The Patient has elements the database does not keep: Patient.name[0]',
    });
    expect(await count('persons')).toBe(before);
    expect(await count('vitals')).toBe(vitals);
    expect((await send('GET', `Patient/${id}`)).body.name).toEqual(ALI.name);
  });

  it('refuses writes to a table without row(), and If-Match on one without versions', async () => {
    expect(
      (await send('POST', 'Location', { resourceType: 'Location', name: 'X' }))
        .status,
    ).toBe(405);
    const { id } = await patient({ ...ALI, identifier: undefined });
    const o = await send('POST', 'Observation', {
      resourceType: 'Observation',
      status: 'final',
      code: { coding: [{ system: LOINC, code: '8480-6' }] },
      subject: { reference: `Patient/${id}` },
    });
    expect(
      (
        await send('DELETE', `Observation/${o.body.id}`, undefined, {
          'If-Match': 'W/"1"',
        })
      ).status,
    ).toBe(412);
    expect((await send('DELETE', `Observation/${o.body.id}`)).status).toBe(204);
  });

  it('runs a transaction Bundle in one database transaction', async () => {
    const { id } = await patient({
      ...ALI,
      identifier: [{ system: NATIONAL_ID, value: '4' }],
    });
    const vital = {
      resourceType: 'Observation',
      status: 'final',
      code: { coding: [{ system: LOINC, code: '8480-6' }] },
      subject: { reference: `Patient/${id}` },
    };
    const bundle = (entries: any[]) => ({
      resourceType: 'Bundle',
      type: 'transaction',
      entry: entries,
    });
    const update = {
      resource: {
        ...ALI,
        id,
        identifier: [{ system: NATIONAL_ID, value: '4' }],
        name: [{ family: 'Demir' }],
      },
      request: { method: 'PUT', url: `Patient/${id}` },
    };
    const vitals = await count('vitals');
    // the update fails after the create (a transaction creates, then
    // updates): the create is undone
    expect(
      await refusal(
        'POST',
        '',
        bundle([
          { ...update, resource: { ...update.resource, gender: 'unknown' } },
          { resource: vital, request: { method: 'POST', url: 'Observation' } },
        ]),
      ),
    ).toMatch(/^422 .*Patient\.gender/);
    expect((await send('GET', `Patient/${id}`)).body.name).toEqual(ALI.name);
    expect(await count('vitals')).toBe(vitals);

    const r = await send(
      'POST',
      '',
      bundle([
        update,
        { resource: vital, request: { method: 'POST', url: 'Observation' } },
      ]),
    );
    expect(r.status).toBe(200);
    expect(r.body.entry.map((e: any) => e.response.status)).toEqual([
      '200 OK',
      '201 Created',
    ]);
    expect((await send('GET', `Patient/${id}`)).body.name).toEqual([
      { family: 'Demir' },
    ]);
    expect(await count('vitals')).toBe(vitals + 1);
    // a new resource referred to by its fullUrl needs an id the server gives
    expect(
      await refusal(
        'POST',
        '',
        bundle([
          {
            fullUrl: 'urn:uuid:5d1f2a0e-0000-4000-8000-000000000001',
            resource: ALI,
            request: { method: 'POST', url: 'Patient' },
          },
          {
            resource: {
              ...vital,
              subject: {
                reference: 'urn:uuid:5d1f2a0e-0000-4000-8000-000000000001',
              },
            },
            request: { method: 'POST', url: 'Observation' },
          },
        ]),
      ),
    ).toMatch(/^400 .*gives ids itself/);
  });

  it('finds the elements a resource read back lacks', () => {
    const read = {
      resourceType: 'Patient',
      id: '1',
      meta: { versionId: '5', lastUpdated: '2026-01-01T00:00:00.000Z' },
      name: [{ family: 'A', given: ['B'] }, { family: 'C' }],
      birthDate: '1980',
      deceasedDateTime: '2020-06-01T10:00:00.000Z',
    };
    expect(
      lostElements(
        {
          resourceType: 'Patient',
          meta: { versionId: '1', lastUpdated: '2025-01-01T00:00:00Z' },
          // in any order, each item once
          name: [{ family: 'C' }, { given: ['B'] }],
          deceasedDateTime: '2020-06-01T12:00:00+02:00',
        },
        read,
      ),
    ).toEqual([]);
    expect(
      lostElements(
        {
          resourceType: 'Patient',
          meta: { profile: ['http://x'] },
          name: [{ family: 'C' }, { family: 'C' }],
          birthDate: '1980-01-01',
          deceasedDateTime: '2020-06-01T10:00:01Z',
          gender: 'male',
        },
        read,
      ),
    ).toEqual([
      'Patient.name[1]',
      'Patient.birthDate',
      'Patient.deceasedDateTime',
      'Patient.gender',
      'Patient.meta.profile',
    ]);
  });
});
