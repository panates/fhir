/**
 * SqlStore's searches through children: a composite whose parts are on one
 * row of a child (an observation's components), and chains and _has through
 * a reference on a child's rows (a patient's general practitioners in a
 * care-team table, limited by `where`). Needs PostgreSQL: FHIR_PG_URL;
 * skipped without it.
 */
import { FhirContext } from '@fhirjs/core';
import { r4Model } from '@fhirjs/r4';
import { FhirServer } from '@fhirjs/server';
import { SqbClient } from '@sqb/connect';
import '@sqb/postgres';
import { expect } from 'expect';
import {
  SqlStore,
  type SqlTable,
  child,
  childTable,
  code,
  composite,
  constant,
  number,
  quantity,
  reference,
  string,
  token,
} from '../src/index.js';

const fhir = new FhirContext(r4Model);
const URL_ = process.env.FHIR_PG_URL;
const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';

const DDL = [
  `create table persons (person_id int primary key, mrn text not null, family text)`,
  `create table doctors (doctor_id int primary key, family text not null)`,
  // a care team: the general practitioners, and others
  `create table care_team (person_id int not null references persons,
     doctor_id int not null references doctors, role text not null)`,
  `create table observations (obs_id int primary key, person_id int not null references persons, code text not null)`,
  `create table obs_components (obs_id int not null references observations,
     code text, value numeric, kind text not null default 'bp')`,
  `insert into persons values (1, 'M1', 'Kaya'), (2, 'M2', 'Demir'), (3, 'M3', 'Yılmaz')`,
  `insert into doctors values (10, 'Smith'), (11, 'Jones'), (12, 'Brown')`,
  // Smith is 1's GP and 2's nurse; Jones is 2's GP; Brown is nobody's GP
  `insert into care_team values (1, 10, 'gp'), (2, 10, 'nurse'), (2, 11, 'gp'), (3, 12, 'nurse')`,
  `insert into observations values (100, 1, '85354-9'), (101, 2, '85354-9'), (102, 3, '29463-7'), (103, 3, '85354-9')`,
  // 100: 120/80; 101: 80/120, the same values on the other rows; 102 none
  `insert into obs_components values
     (100, '8480-6', 120), (100, '8462-4', 80),
     (101, '8480-6', 80), (101, '8462-4', 120)`,
  // a row the parameters' where leaves out
  `insert into obs_components values (102, '8480-6', 120, 'other')`,
  // a code on one row and a value on another: no row has both
  `insert into obs_components values (103, '8480-6', null), (103, null, 90)`,
];

const patient = (): SqlTable => ({
  table: 'persons',
  id: 'person_id',
  select: a => `${a}.person_id::text as id, ${a}.mrn, ${a}.family`,
  resource: (r, c) => ({
    resourceType: 'Patient',
    id: r.id,
    identifier: [{ system: 'urn:mrn', value: r.mrn }],
    name: [{ family: r.family }],
    ...(c.gps.length && {
      generalPractitioner: c.gps.map(g => ({
        reference: `Practitioner/${g.doctor_id}`,
      })),
    }),
  }),
  children: {
    gps: childTable({
      table: 'care_team',
      fk: 'person_id',
      select: a => `${a}.doctor_id::text as doctor_id, ${a}.role`,
      order: a => `${a}.doctor_id`,
    }),
  },
  params: {
    identifier: token(code('mrn', { system: 'urn:mrn' })),
    family: string('family'),
    // the care team's rows of a GP only
    'general-practitioner': child(
      'gps',
      reference('doctor_id', 'Practitioner'),
      a => `${a}.role = 'gp'`,
    ),
  },
});

const practitioner = (): SqlTable => ({
  table: 'doctors',
  id: 'doctor_id',
  select: a => `${a}.doctor_id::text as id, ${a}.family`,
  resource: r => ({
    resourceType: 'Practitioner',
    id: r.id,
    name: [{ family: r.family }],
  }),
  params: { name: string('family') },
});

const observation = (): SqlTable => ({
  table: 'observations',
  id: 'obs_id',
  select: a =>
    `${a}.obs_id::text as id, ${a}.person_id::text as person_id, ${a}.code`,
  resource: (r, c) => ({
    resourceType: 'Observation',
    id: r.id,
    status: 'final',
    code: { coding: [{ system: LOINC, code: r.code }] },
    subject: { reference: `Patient/${r.person_id}` },
    ...(c.components.length && {
      component: c.components.map(k => ({
        code: k.code
          ? { coding: [{ system: LOINC, code: k.code }] }
          : { text: 'not coded' },
        ...(k.value !== null && {
          valueQuantity: {
            value: Number(k.value),
            system: UCUM,
            code: 'mm[Hg]',
          },
        }),
      })),
    }),
  }),
  children: {
    components: childTable({
      table: 'obs_components',
      fk: 'obs_id',
      select: a => `${a}.code, ${a}.value`,
      order: a => `${a}.code`,
    }),
  },
  params: {
    code: token(code('code', { system: LOINC })),
    subject: reference('person_id', 'Patient'),
    'component-code': child(
      'components',
      token(code('code', { system: LOINC })),
      a => `${a}.kind = 'bp'`,
    ),
    'component-value-quantity': child(
      'components',
      quantity(number('value'), constant('mm[Hg]', { system: UCUM })),
      a => `${a}.kind = 'bp'`,
    ),
    'component-code-value-quantity': composite(),
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

describe('SqlStore searches through children', function () {
  const schema = `sqlchildsearch_${Math.random().toString(36).slice(2, 10)}`;
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
      store: new SqlStore({
        client,
        types: {
          Patient: patient(),
          Practitioner: practitioner(),
          Observation: observation(),
        },
      }),
      resources: ['Patient', 'Practitioner', 'Observation'],
    });
  });

  after(async () => {
    await client?.close();
    if (admin) {
      await admin.execute(`drop schema if exists ${schema} cascade`);
      await admin.close();
    }
  });

  const search = async (path: string) => {
    const r = await server.handle(new Request(`http://localhost/${path}`));
    const body = await r.json();
    if (r.status !== 200) return `${r.status} ${body.issue?.[0]?.diagnostics}`;
    return (body.entry ?? [])
      .map((e: any) => e.resource.id)
      .sort()
      .join(',');
  };

  it('answers a composite on one row of a child', async () => {
    const q = (v: string) =>
      search(
        `Observation?component-code-value-quantity=${encodeURIComponent(v)}`,
      );
    expect([
      // 120 systolic: 100 only, though 101 has 8480-6 and 120 on other rows
      await q(`${LOINC}|8480-6$120`),
      await q('8480-6$120'),
      await q('8462-4$120'),
      await q('8462-4$80|http://unitsofmeasure.org|mm[Hg]'),
      await q('8480-6$gt100'),
      // either value
      await q('8480-6$120,8462-4$120'),
      await q('8480-6$999'),
      // the parts alone: any row
      await search(
        'Observation?component-code=8480-6&component-value-quantity=120',
      ),
      await search('Observation?component-code-value-quantity:missing=true'),
      await search('Observation?component-code-value-quantity:missing=false'),
    ]).toEqual([
      '100',
      '100',
      '101',
      '100',
      '100',
      '100,101',
      '',
      '100,101',
      '102,103',
      '100,101',
    ]);
  });

  it('chains through a reference on a child’s rows, within its where', async () => {
    expect([
      await search('Patient?general-practitioner.name=Smith'),
      await search('Patient?general-practitioner.name=Jones'),
      // Brown is a nurse only
      await search('Patient?general-practitioner.name=Brown'),
      await search('Patient?general-practitioner=Practitioner/10'),
      await search(
        'Patient?general-practitioner:Practitioner.name=Smith,Jones',
      ),
      // two levels: the observations of patients whose GP is Jones
      await search('Observation?subject.general-practitioner.name=Jones'),
      await search('Patient?general-practitioner.name:missing=false'),
    ]).toEqual(['1', '2', '', '1', '1,2', '101', '1,2']);
  });

  it('finds the targets of a child’s references by _has', async () => {
    expect([
      await search(
        'Practitioner?_has:Patient:general-practitioner:identifier=urn:mrn|M1',
      ),
      await search(
        'Practitioner?_has:Patient:general-practitioner:family=Demir',
      ),
      // the GPs of anyone: not Brown, a nurse only
      await search(
        'Practitioner?_has:Patient:general-practitioner:family:missing=false',
      ),
      // through two: the GPs of patients with a blood pressure of 120 systolic
      await search(
        `Practitioner?_has:Patient:general-practitioner:_has:Observation:subject:component-code-value-quantity=${encodeURIComponent('8480-6$120')}`,
      ),
    ]).toEqual(['10', '11', '10,11', '10']);
  });
});
