/**
 * SqlStore against the meaning of each search parameter, on a schema of
 * another shape than examples/facade: an id column not named id, a code in
 * a table of its own, a unit every row shares, a parameter answered by code
 * of its own. The same searches on a server over the store and on a server
 * over the same resources matched by FHIRPath must find the same resources,
 * in the same order. Needs PostgreSQL: FHIR_PG_URL; skipped without it.
 */
import { FhirContext } from '@fhirjs/core';
import { r4Model } from '@fhirjs/r4';
import {
  type FhirStore,
  FhirServer,
  type SearchQuery,
  type StorePage,
  type StoredResource,
} from '@fhirjs/server';
import { Eq, IsNot, Not, Or, Raw } from '@sqb/builder';
import { SqbClient } from '@sqb/connect';
import '@sqb/postgres';
import { expect } from 'expect';
import {
  type Cond,
  SqlStore,
  code,
  composite,
  constant,
  date,
  day,
  instant,
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
const PERSON = 'urn:example:person';
// the database's codes sort otherwise than FHIR's
const SEX: Record<string, string> = {
  '1': 'male',
  '2': 'female',
  '9': 'other',
};

const DDL = [
  `create table persons (
     person_no int primary key, family_name text not null, sex text, born date,
     changed timestamptz not null)`,
  `create table vital_kinds (kind_id int primary key, loinc text not null, label text not null)`,
  `create table vitals (
     vital_id int primary key, person_no int not null references persons,
     kind_id int not null references vital_kinds, measured_at timestamptz, value numeric,
     changed timestamptz not null)`,
];

/** Rows the same on every run */
function seed(): string[] {
  const families = ['Şahin', 'Sahin', 'Schmidt', 'Smith', 'Çelik', 'Celikkol'];
  const sexes = ['1', '2', '9', null];
  const rows: string[] = [];
  const q = (v: unknown) =>
    v === null ? 'null' : typeof v === 'number' ? String(v) : `'${v}'`;
  for (let n = 1; n <= 8; n++)
    rows.push(
      // numbers whose text sorts otherwise than they do
      `insert into persons values (${n * 7}, ${q(families[n % families.length])}, ${q(
        sexes[n % sexes.length],
      )}, ${q(n === 3 ? null : `19${60 + n * 4}-0${(n % 9) + 1}-15`)}, '2026-01-0${n}T10:00:00Z')`,
    );
  rows.push(
    `insert into vital_kinds values (1, '8480-6', 'Systolic'), (2, '8462-4', 'Diastolic')`,
  );
  for (let n = 1; n <= 40; n++) {
    const kind = (n % 2) + 1;
    const value =
      n % 11 === 0
        ? null
        : kind === 1
          ? 100 + ((n * 7) % 60)
          : 60 + ((n * 5) % 35);
    const at =
      n % 13 === 0
        ? null
        : new Date(Date.UTC(2025, 0, 1, 8) + n * 37 * 3600_000).toISOString();
    rows.push(
      `insert into vitals values (${n}, ${((n % 8) + 1) * 7}, ${kind}, ${q(at)}, ${q(
        value,
      )}, '2026-02-01T00:00:00Z')`,
    );
  }
  return rows;
}

const instantText = (e: string) =>
  `to_char(${e} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const compact = (o: Record<string, any>) => {
  for (const k of Object.keys(o)) if (o[k] == null) delete o[k];
  return o;
};

/** identifier, answered by code of its own: the person number under one system */
function personIdentifier(
  ctx: { alias: string; params: { add(v: unknown): any } },
  c: {
    missing?: boolean;
    modifier?: string;
    values: { system?: string; code?: string }[];
  },
): Cond {
  if (c.missing !== undefined) return Raw(c.missing ? 'false' : 'true') as any;
  const col = Raw(`cast(${ctx.alias}.person_no as text)`);
  const any = Or(
    ...c.values.map(v =>
      (v.system === undefined || v.system === PERSON) && v.code !== undefined
        ? Eq(col, ctx.params.add(v.code))
        : v.system === PERSON && v.code === undefined
          ? IsNot(col, null)
          : Raw('false'),
    ),
  );
  return (c.modifier === 'not' ? Not(any) : any) as unknown as Cond;
}

const store = (client: SqbClient) =>
  new SqlStore({
    client,
    types: {
      Patient: {
        table: 'persons',
        id: 'person_no',
        lastUpdated: 'changed',
        select: a => `${a}.person_no::text as id, ${a}.family_name, ${a}.sex,
          ${a}.born::text as born, ${instantText(`${a}.changed`)} as changed`,
        resource: r =>
          compact({
            resourceType: 'Patient',
            id: r.id,
            meta: { lastUpdated: r.changed },
            identifier: [{ system: PERSON, value: r.id }],
            name: [{ family: r.family_name }],
            gender: r.sex ? SEX[r.sex] : undefined,
            birthDate: r.born,
          }),
        params: {
          identifier: personIdentifier as any,
          family: string('family_name'),
          gender: token(code('sex', { map: SEX })),
          birthdate: date(day('born')),
        },
        sort: [
          'family',
          'gender',
          'birthdate',
          { param: '_lastUpdated', key: a => `${a}.changed` },
        ],
      },
      Observation: {
        table: 'vitals',
        id: 'vital_id',
        lastUpdated: 'changed',
        select: a => `${a}.vital_id::text as id, ${a}.person_no::text as person,
          (select k.loinc from vital_kinds k where k.kind_id = ${a}.kind_id) as loinc,
          ${instantText(`${a}.measured_at`)} as measured_at, ${a}.value::float8 as value,
          ${instantText(`${a}.changed`)} as changed`,
        resource: r =>
          compact({
            resourceType: 'Observation',
            id: r.id,
            meta: { lastUpdated: r.changed },
            status: 'final',
            category: [
              {
                coding: [
                  {
                    system:
                      'http://terminology.hl7.org/CodeSystem/observation-category',
                    code: 'vital-signs',
                  },
                ],
              },
            ],
            code: { coding: [{ system: LOINC, code: r.loinc }] },
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
        params: {
          // the code is in a table of its own
          code: token(
            code(
              a =>
                `(select k.loinc from vital_kinds k where k.kind_id = ${a}.kind_id)`,
              { system: LOINC },
            ),
          ),
          category: token(
            constant('vital-signs', {
              system:
                'http://terminology.hl7.org/CodeSystem/observation-category',
            }),
          ),
          subject: reference('person_no', 'Patient'),
          patient: reference('person_no', 'Patient'),
          date: date(instant('measured_at')),
          // every row's unit is the same
          'value-quantity': quantity(
            number('value'),
            constant('mm[Hg]', { system: UCUM }),
          ),
          'code-value-quantity': composite(),
        },
        sort: ['date', 'value-quantity', 'subject', 'code'],
      },
    },
  });

/** The store's resources, kept as they are and matched by FHIRPath */
class FixtureStore implements FhirStore {
  constructor(
    private readonly _sql: SqlStore,
    private readonly _all: Map<string, Record<string, any>[]>,
  ) {}

  capabilities(type: string) {
    return this._sql.capabilities(type);
  }

  async read(type: string, id: string) {
    const r = this._all.get(type)?.find(x => x.id === id);
    return r && stored(r);
  }

  async search(
    type: string,
    query: SearchQuery,
  ): Promise<StorePage<StoredResource>> {
    const lookup = {
      read: (t: string, id: string) => this._all.get(t)?.find(x => x.id === id),
      all: (t: string) => this._all.get(t) ?? [],
    };
    const found = (this._all.get(type) ?? []).filter(r =>
      query.matches(r, lookup),
    );
    if (query.sort.length) found.sort((a, b) => query.compare(a, b));
    return {
      items: found.slice(query.offset, query.offset + query.count).map(stored),
      total: found.length,
    };
  }
}

const stored = (r: Record<string, any>): StoredResource => ({
  type: r.resourceType,
  id: r.id,
  resource: r,
  lastUpdated: r.meta?.lastUpdated,
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

describe('SqlStore over tables of another shape', function () {
  const TYPES = ['Patient', 'Observation'];
  const schema = `sqlstore_${Math.random().toString(36).slice(2, 10)}`;
  let admin: SqbClient;
  let client: SqbClient;
  let sqlStore: SqlStore;
  let sql: FhirServer;
  let memory: FhirServer;
  let all: Map<string, Record<string, any>[]>;

  before(async function () {
    if (!URL_) return this.skip();
    admin = clientOf(URL_);
    await admin.execute(
      'create extension if not exists unaccent with schema public',
    );
    await admin.execute(`create schema ${schema}`);
    await admin.acquire(async connection => {
      await connection.execute(`set search_path to ${schema}`);
      for (const s of [...DDL, ...seed()]) await connection.execute(s);
    });
    client = clientOf(URL_, schema);
    sqlStore = store(client);
    all = new Map();
    for (const type of TYPES) {
      const page = await sqlStore.search(type, {
        type,
        criteria: [],
        sort: [],
        count: 1000,
        offset: 0,
        matches: () => true,
        compare: () => 0,
      });
      all.set(
        type,
        page.items.map(s => s.resource!),
      );
    }
    sql = new FhirServer({ fhir, store: sqlStore, resources: TYPES });
    memory = new FhirServer({
      fhir,
      store: new FixtureStore(sqlStore, all),
      resources: TYPES,
    });
  });

  after(async () => {
    await client?.close();
    if (admin) {
      await admin.execute(`drop schema if exists ${schema} cascade`);
      await admin.close();
    }
  });

  const answer = async (server: FhirServer, path: string) => {
    const r = await server.handle(
      new Request(`http://localhost/${path}`, {
        headers: { Prefer: 'handling=strict' },
      }),
    );
    const body = await r.json();
    if (r.status !== 200) return `${r.status} ${body.issue[0].diagnostics}`;
    return `${body.total} ${(body.entry ?? [])
      .map(
        (e: any) =>
          `${e.search?.mode === 'include' ? '+' : ''}${e.resource.id}`,
      )
      .join(',')}`;
  };

  const same = async (paths: string[]) => {
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const path of paths) {
      got[path] = await answer(sql, path);
      want[path] = await answer(memory, path);
    }
    expect(got).toEqual(want);
    const found = Object.values(want).filter(a => !/^0 /.test(a));
    expect(found.length).toBeGreaterThan(paths.length / 2);
  };

  it('maps every row to a valid resource, and reads it by its own id column', async () => {
    expect([...all.values()].map(l => l.length)).toEqual([8, 40]);
    for (const list of all.values())
      for (const r of list)
        expect(
          fhir.validate(r).issues.filter(i => i.severity === 'error'),
        ).toEqual([]);
    const p = await (
      await sql.handle(new Request('http://localhost/Patient/21'))
    ).json();
    expect(p).toEqual(all.get('Patient')!.find(x => x.id === '21'));
    expect(
      (await sql.handle(new Request('http://localhost/Patient/3'))).status,
    ).toBe(404);
  });

  it('searches as FHIR does', async () => {
    await same([
      'Patient?_id=21,28',
      'Patient?_id:not=21',
      'Patient?identifier=35',
      'Patient?identifier=urn:example:person|35',
      'Patient?identifier=urn:x|35',
      'Patient?identifier=urn:example:person|',
      'Patient?identifier:not=35',
      'Patient?identifier:missing=false',
      'Patient?family=sahin',
      'Patient?family=celik',
      'Patient?family:exact=Sahin',
      'Patient?family:contains=mi',
      'Patient?gender=female',
      'Patient?gender:not=male',
      'Patient?gender:missing=true',
      'Patient?birthdate=lt1980',
      'Patient?birthdate:missing=true',
      'Patient?_lastUpdated=ge2026-01-04',
      'Observation?code=8480-6',
      'Observation?code=http://loinc.org|8462-4',
      'Observation?code:not=8480-6',
      'Observation?category=vital-signs',
      'Observation?subject=Patient/21',
      'Observation?patient=21',
      'Observation?subject=http://localhost/Patient/21',
      'Observation?subject=http://elsewhere/Patient/21',
      'Observation?date=ge2025-02-01',
      'Observation?date:missing=true',
      'Observation?value-quantity=gt140',
      'Observation?value-quantity=120|http://unitsofmeasure.org|mm[Hg]',
      'Observation?value-quantity=120||mm[Hg]',
      'Observation?value-quantity=120|http://unitsofmeasure.org|kPa',
      'Observation?value-quantity:missing=true',
      'Observation?code-value-quantity=8480-6$gt130',
      'Observation?code-value-quantity:missing=true',
      'Observation?subject:Patient.family=sahin',
      'Observation?subject:Patient.gender=female&code=8462-4',
      'Patient?_has:Observation:subject:value-quantity=gt150',
      'Patient?_has:Observation:subject:date:missing=true',
    ]);
  });

  it('sorts by the key of each kind, and by a key of its own', async () => {
    await same([
      'Patient?_sort=family',
      'Patient?_sort=-family',
      'Patient?_sort=gender,family',
      'Patient?_sort=-gender',
      'Patient?_sort=birthdate',
      'Patient?_sort=-birthdate',
      'Patient?_sort=-_lastUpdated',
      'Observation?_sort=value-quantity&_count=12',
      'Observation?_sort=-value-quantity&_count=12&_offset=12',
      'Observation?_sort=subject,-date&_count=15',
      'Observation?_sort=-code,date&_count=10',
    ]);
  });

  it('refuses a sort key its kind does not have', () => {
    expect(
      () =>
        new SqlStore({
          client: undefined as any,
          types: {
            Patient: {
              table: 'p',
              select: () => '*',
              resource: r => r,
              params: { name: string('a', 'b') },
              sort: ['name'],
            },
          },
        }),
    ).toThrow('Patient: name has no sort key of its kind');
  });
});
