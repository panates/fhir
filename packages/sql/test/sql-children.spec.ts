/**
 * SqlStore's children: rows of a resource in tables of their own, read a
 * page at a time, searched with EXISTS, sorted by the lowest or highest of
 * their rows and written with the parent. The facade example covers a child
 * written by its key and one written by code of its own; this covers a
 * child without a key and one that is only read. Needs PostgreSQL:
 * FHIR_PG_URL; skipped without it.
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
  onlyElements,
  string,
  token,
} from '../src/index.js';

const fhir = new FhirContext(r4Model);
const URL_ = process.env.FHIR_PG_URL;
const LANGUAGE = 'urn:ietf:bcp:47';

const DDL = [
  `create table persons (person_id bigint generated always as identity primary key, mrn text not null)`,
  // no key: a person's names are deleted and inserted again
  `create table person_names (
     name_id bigint generated always as identity primary key,
     person_id bigint not null references persons, family text, given text, ord int not null)`,
  // kept by another system: read, never written
  `create table person_languages (person_id bigint not null references persons, lang text not null)`,
  // a child of a child: an address's lines, without a cascade (removed first)
  `create table person_addresses (
     address_id bigint generated always as identity primary key,
     person_id bigint not null references persons, kind text not null, city text)`,
  `create table address_lines (
     line_id bigint generated always as identity primary key,
     address_id bigint not null references person_addresses, line text not null, ord int not null)`,
];

const patient = (): SqlTable => ({
  table: 'persons',
  id: 'person_id',
  select: a => `${a}.person_id::text as id, ${a}.mrn`,
  resource: (r, c) => ({
    resourceType: 'Patient',
    id: r.id,
    identifier: [{ system: 'urn:mrn', value: r.mrn }],
    ...(c.names.length && {
      name: c.names.map(n => ({
        family: n.family ?? undefined,
        given: n.given ? [n.given] : undefined,
      })),
    }),
    ...(c.languages.length && {
      communication: c.languages.map(l => ({
        language: { coding: [{ system: LANGUAGE, code: l.lang }] },
      })),
    }),
    ...(c.addresses.length && {
      address: c.addresses.map(a => ({
        use: a.kind,
        ...(a.lines.length && { line: a.lines.map((l: any) => l.line) }),
        city: a.city ?? undefined,
      })),
    }),
  }),
  row: r => {
    onlyElements(r, ['identifier', 'name', 'communication', 'address']);
    return { mrn: r.identifier?.[0]?.value ?? null };
  },
  children: {
    names: childTable({
      table: 'person_names',
      fk: 'person_id',
      select: a => `${a}.name_id::int as name_id, ${a}.family, ${a}.given`,
      order: a => `${a}.ord`,
      rows: r =>
        (r.name ?? []).map((n: any, ord: number) => ({
          family: n.family ?? null,
          given: n.given?.[0] ?? null,
          ord,
        })),
    }),
    languages: childTable({
      table: 'person_languages',
      fk: 'person_id',
      select: a => `${a}.lang`,
      order: a => `${a}.lang`,
    }),
    addresses: childTable({
      table: 'person_addresses',
      fk: 'person_id',
      id: 'address_id',
      select: a => `${a}.kind, ${a}.city`,
      order: a => `${a}.address_id`,
      key: ['kind'],
      // under lines: the address its lines are of
      rows: r =>
        (r.address ?? []).map((a: any) => ({
          kind: a.use ?? null,
          city: a.city ?? null,
          lines: a,
        })),
      children: {
        lines: childTable({
          table: 'address_lines',
          fk: 'address_id',
          select: a => `${a}.line`,
          order: a => `${a}.ord`,
          rows: a =>
            (a.line ?? []).map((line: string, ord: number) => ({ line, ord })),
        }),
      },
    }),
  },
  params: {
    family: child('names', string('family')),
    language: child('languages', token(code('lang', { system: LANGUAGE }))),
    // the lines of the addresses: a child of a child
    address: child('addresses.lines', string('line')),
    'address-city': child('addresses', string('city')),
  },
  sort: ['family'],
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

describe('SqlStore children', function () {
  const schema = `sqlchildren_${Math.random().toString(36).slice(2, 10)}`;
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
      store: new SqlStore({ client, types: { Patient: patient() } }),
      resources: ['Patient'],
    });
  });

  after(async () => {
    await client?.close();
    if (admin) {
      await admin.execute(`drop schema if exists ${schema} cascade`);
      await admin.close();
    }
  });

  const send = async (method: string, path: string, body?: unknown) => {
    const r = await server.handle(
      new Request(`http://localhost/${path}`, {
        method,
        headers:
          body === undefined ? {} : { 'Content-Type': 'application/fhir+json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
  };
  const rows = async (sql: string) =>
    (await client.execute(sql, { objectRows: true })).rows!;
  const ids = (bundle: any) =>
    (bundle.entry ?? []).map((e: any) => e.resource.id).join(',');

  it('writes a child without a key by deleting and inserting its rows', async () => {
    const created = await send('POST', 'Patient', {
      resourceType: 'Patient',
      identifier: [{ system: 'urn:mrn', value: 'A1' }],
      name: [{ family: 'Kaya', given: ['Ayşe'] }, { family: 'Demir' }],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(created.body.name).toEqual([
      { family: 'Kaya', given: ['Ayşe'] },
      { family: 'Demir' },
    ]);
    const before = await rows(
      `select name_id::int as id from person_names where person_id = ${id}`,
    );
    const swapped = {
      ...created.body,
      name: [...created.body.name].reverse(),
    };
    const updated = await send('PUT', `Patient/${id}`, swapped);
    expect(updated.status).toBe(200);
    expect(updated.body.name).toEqual(swapped.name);
    const after = await rows(
      `select name_id::int as id from person_names where person_id = ${id}`,
    );
    expect(after.length).toBe(2);
    expect(after.some(a => before.some(b => b.id === a.id))).toBe(false);
    expect((await send('DELETE', `Patient/${id}`)).status).toBe(204);
    expect(
      await rows(`select * from person_names where person_id = ${id}`),
    ).toEqual([]);
  });

  it('reads a child that is not written, and refuses a resource that changes it', async () => {
    const p = (
      await send('POST', 'Patient', {
        resourceType: 'Patient',
        identifier: [{ system: 'urn:mrn', value: 'B1' }],
        name: [{ family: 'Brown' }],
      })
    ).body;
    await client.execute(
      `insert into person_languages values (${p.id}, 'tr'), (${p.id}, 'en')`,
    );
    const read = (await send('GET', `Patient/${p.id}`)).body;
    expect(read.communication).toEqual([
      { language: { coding: [{ system: LANGUAGE, code: 'en' }] } },
      { language: { coding: [{ system: LANGUAGE, code: 'tr' }] } },
    ]);
    // the languages as they are, the names gone: written
    const { name: _name, ...noName } = read;
    expect((await send('PUT', `Patient/${p.id}`, noName)).status).toBe(200);
    // a language the table does not have: refused, the names not changed
    const refused = await send('PUT', `Patient/${p.id}`, {
      ...read,
      name: [{ family: 'Green' }],
      communication: [
        { language: { coding: [{ system: LANGUAGE, code: 'de' }] } },
      ],
    });
    expect(`${refused.status} ${refused.body.issue[0].diagnostics}`).toBe(
      '422 The Patient has elements the database does not keep: Patient.communication[0]',
    );
    const now = (await send('GET', `Patient/${p.id}`)).body;
    expect(now.name).toBeUndefined();
    expect(now.communication.length).toBe(2);
  });

  it('searches and sorts by the rows of a child, a page at a time', async () => {
    const make = async (mrn: string, families: string[], langs: string[]) => {
      const id = (
        await send('POST', 'Patient', {
          resourceType: 'Patient',
          identifier: [{ system: 'urn:mrn', value: mrn }],
          ...(families.length && {
            name: families.map(family => ({ family })),
          }),
        })
      ).body.id;
      for (const l of langs)
        await client.execute(
          `insert into person_languages values (${id}, '${l}')`,
        );
      return id as string;
    };
    await client.execute('delete from person_languages');
    await client.execute('delete from person_names');
    await client.execute('delete from persons');
    const a = await make('S1', ['Smith', 'Adams'], ['tr']);
    const b = await make('S2', ['Brown'], ['en', 'tr']);
    const c = await make('S3', ['Young', 'Smithers'], []);
    const d = await make('S4', [], ['de']);
    const search = async (q: string) =>
      ids((await send('GET', `Patient?${q}`)).body);
    expect([
      await search('family=smith'),
      await search('family=smith&language=tr'),
      await search('language=urn:ietf:bcp:47|tr'),
      await search('language:not=tr'),
      await search('family:missing=true'),
      await search('language:missing=true'),
      // the lowest of a patient's names ascending, the highest descending; none last
      await search('_sort=family'),
      await search('_sort=-family'),
      await search('_sort=family&_count=2&_offset=1'),
    ]).toEqual([
      `${a},${c}`,
      a,
      `${a},${b}`,
      `${c},${d}`,
      d,
      c,
      `${a},${b},${c},${d}`,
      `${c},${a},${b},${d}`,
      `${b},${c}`,
    ]);
    // a page's names, each with its own patient
    const page = (await send('GET', 'Patient?_sort=family&_count=3')).body;
    expect(
      page.entry.map((e: any) =>
        (e.resource.name ?? []).map((n: any) => n.family).join('/'),
      ),
    ).toEqual(['Smith/Adams', 'Brown', 'Young/Smithers']);
  });

  it("reads, writes and searches a child of a child: an address's lines", async () => {
    const lines = () =>
      rows(`select l.line_id::int as id, a.kind, l.line from address_lines l
              join person_addresses a using (address_id) order by a.kind, l.ord`);
    const addresses = () =>
      rows(
        `select address_id::int as id, kind from person_addresses order by kind`,
      );
    const created = await send('POST', 'Patient', {
      resourceType: 'Patient',
      identifier: [{ system: 'urn:mrn', value: 'D1' }],
      address: [
        { use: 'home', line: ['1 Main St', 'Flat 2'], city: 'Ankara' },
        { use: 'work', line: ['9 Office Rd'], city: 'Izmir' },
      ],
    });
    expect(created.status).toBe(201);
    const p = created.body;
    expect(p.address).toEqual([
      { use: 'home', line: ['1 Main St', 'Flat 2'], city: 'Ankara' },
      { use: 'work', line: ['9 Office Rd'], city: 'Izmir' },
    ]);
    const before = await lines();
    const ids0 = await addresses();
    // home's lines change; the work address and its line rows are kept
    const changed = {
      ...p,
      address: [
        { use: 'home', line: ['3 New St'], city: 'Ankara' },
        { use: 'work', line: ['9 Office Rd'], city: 'Izmir' },
      ],
    };
    const u = await send('PUT', `Patient/${p.id}`, changed);
    expect([u.status, u.body.address]).toEqual([200, changed.address]);
    expect(await addresses()).toEqual(ids0);
    const after = await lines();
    expect(after.map(l => [l.kind, l.line])).toEqual([
      ['home', '3 New St'],
      ['work', '9 Office Rd'],
    ]);
    // without a key below: the work address's line rows are written again too
    expect(after[1].id).not.toBe(before[2].id);

    const other = (
      await send('POST', 'Patient', {
        resourceType: 'Patient',
        identifier: [{ system: 'urn:mrn', value: 'D2' }],
        address: [{ use: 'home', line: ['1 Main St'], city: 'Bursa' }],
      })
    ).body;
    const search = async (q: string) =>
      ((await send('GET', `Patient?${q}`)).body.entry ?? [])
        .map((e: any) => e.resource.id)
        .sort()
        .join(',');
    expect([
      await search('address=3 New'),
      await search('address=1 Main'),
      await search('address=9 office'),
      await search('address-city=Bursa'),
      await search(`address:missing=true&_id=${p.id},${other.id}`),
    ]).toEqual([p.id, other.id, p.id, other.id, '']);

    // an address gone: its lines first (no cascade), then the address
    const less = { ...changed, address: [changed.address[0]] };
    expect((await send('PUT', `Patient/${p.id}`, less)).status).toBe(200);
    expect((await lines()).map(l => l.line).sort()).toEqual([
      '1 Main St',
      '3 New St',
    ]);
    // deleted: every row, the lines first
    expect((await send('DELETE', `Patient/${p.id}`)).status).toBe(204);
    expect((await send('DELETE', `Patient/${other.id}`)).status).toBe(204);
    expect([await addresses(), await lines()]).toEqual([[], []]);
  });

  it('refuses a parameter over a child the table does not have', () => {
    const t = patient();
    t.params = { family: child('nope', string('family')) };
    expect(
      () => new SqlStore({ client: {} as any, types: { Patient: t } }),
    ).toThrow(
      'Patient: child(nope) names no child of the table that can be joined',
    );
    // a child of a child whose rows have no id to join
    t.params = { family: child('names.lines', string('line')) };
    expect(
      () => new SqlStore({ client: {} as any, types: { Patient: t } }),
    ).toThrow(
      'Patient: child(names.lines) names no child of the table that can be joined',
    );
    expect(() =>
      childTable({
        table: 'x',
        fk: 'p',
        select: a => a,
        children: { y: childTable({ table: 'y', fk: 'x', select: a => a }) },
      }),
    ).toThrow(
      "childTable(x): a table with children needs the column of its rows' id",
    );
  });
});
