/**
 * A facade over the EMR's tables: reads and searches Patient, Encounter and
 * Observation from them, searches translated to SQL with sqb.
 */
import { And, Eq, Exists, Not, Or, Raw, Select } from '@sqb/builder';
import type { SqbClient } from '@sqb/connect';
import {
  type FhirStore,
  FhirServerError,
  type SearchCriterion,
  type SearchQuery,
  type StoreCapabilities,
  type StorePage,
  type StoredResource,
} from '@fhirjs/server';
import {
  ACT_CODE,
  CATEGORY,
  ENCOUNTER_STATUS,
  GENDER,
  ICD10,
  LOINC,
  MRN,
  NATIONAL_ID,
  UCUM,
  encounterColumns,
  encounterOf,
  observationColumns,
  observationOf,
  patientColumns,
  patientOf,
} from './mapping.js';
import {
  type Cond,
  FALSE,
  type ParamSql,
  SqlParams,
  codeColumn,
  constantCode,
  date,
  dateColumn,
  instantColumn,
  normalizeSql,
  quantity,
  reference,
  strings,
  token,
} from './sql-search.js';

/** A resource type kept in a table */
interface TableMap {
  table: string;
  columns(alias: string): string;
  resource(row: Record<string, any>): Record<string, any>;
  /** The search parameters it answers, by code, on a row of the alias */
  params: Record<string, (alias: string) => ParamSql>;
  /** Reference parameters by foreign key, for chains and _has */
  refs: Record<string, { fk: (alias: string) => string; target: string }>;
  /** _sort: the key of a row, by direction (a period's key is its start ascending, its end descending) */
  sort: Record<string, (alias: string, descending: boolean) => string>;
}

const id = (a: string) => token(codeColumn(`cast(${a}.id as text)`));
const lastUpdated = (a: string) => date(instantColumn(`${a}.updated_at`));

const PATIENT: TableMap = {
  table: 'patients',
  columns: patientColumns,
  resource: patientOf,
  params: {
    _id: id,
    _lastUpdated: lastUpdated,
    identifier: a =>
      token(
        codeColumn(`${a}.mrn`, MRN),
        codeColumn(`${a}.national_id`, NATIONAL_ID),
      ),
    name: a => strings(`${a}.last_name`, `${a}.first_name`, `${a}.middle_name`),
    family: a => strings(`${a}.last_name`),
    given: a => strings(`${a}.first_name`, `${a}.middle_name`),
    gender: a => token(codeColumn(`${a}.gender`, undefined, GENDER)),
    birthdate: a => date(dateColumn(`${a}.birth_date`)),
    active: a =>
      token(
        codeColumn(`${a}.active`, undefined, { true: 'true', false: 'false' }),
      ),
    // a ContactPoint's value is found with or without its system
    phone: a =>
      token(codeColumn(`${a}.phone`), codeColumn(`${a}.phone`, 'phone')),
    email: a =>
      token(codeColumn(`${a}.email`), codeColumn(`${a}.email`, 'email')),
    'address-city': a => strings(`${a}.city`),
    deceased: a =>
      token(
        codeColumn(
          `(case when ${a}.deceased_at is null then 'false' else 'true' end)`,
        ),
      ),
  },
  refs: {},
  sort: {
    family: a => `${normalizeSql(`${a}.last_name`)} collate "C"`,
    birthdate: (a, desc) =>
      desc ? `(${a}.birth_date + 1)` : `${a}.birth_date`,
  },
};

const encounterPatient = (a: string) => reference(`${a}.patient_id`, 'Patient');
const ENCOUNTER: TableMap = {
  table: 'encounters',
  columns: encounterColumns,
  resource: encounterOf,
  params: {
    _id: id,
    _lastUpdated: lastUpdated,
    identifier: a =>
      token(codeColumn(`${a}.encounter_no`, 'urn:example:encounter')),
    patient: encounterPatient,
    subject: encounterPatient,
    status: a => token(codeColumn(`${a}.status`, undefined, ENCOUNTER_STATUS)),
    class: a =>
      token(
        codeColumn(`${a}.kind`, ACT_CODE, {
          inpatient: 'IMP',
          outpatient: 'AMB',
          emergency: 'EMER',
        }),
      ),
    // date (the period) waits for sqb: see periodColumns()
    'reason-code': a => token(codeColumn(`${a}.diagnosis_code`, ICD10)),
  },
  refs: {
    patient: { fk: a => `${a}.patient_id`, target: 'Patient' },
    subject: { fk: a => `${a}.patient_id`, target: 'Patient' },
  },
  // _sort=date comes with the date parameter: a period's key is its start
  // ascending (or its end), its end descending (or its start)
  sort: {},
};

const resultPatient = (a: string) => reference(`${a}.patient_id`, 'Patient');
const OBSERVATION: TableMap = {
  table: 'lab_results',
  columns: observationColumns,
  resource: observationOf,
  params: {
    _id: id,
    _lastUpdated: lastUpdated,
    patient: resultPatient,
    subject: resultPatient,
    encounter: a => reference(`${a}.encounter_id`, 'Encounter'),
    code: a => token(codeColumn(`${a}.test_code`, LOINC)),
    category: () => token(constantCode('laboratory', CATEGORY)),
    status: a => token(codeColumn(`${a}.status`)),
    date: a => date(instantColumn(`${a}.collected_at`)),
    'value-quantity': a =>
      quantity(`cast(${a}.value_numeric as float8)`, `${a}.unit`, UCUM),
    // a composite: its parts' parameters on the same row
    'code-value-quantity': () => ({ present: FALSE, value: () => FALSE }),
  },
  refs: {
    patient: { fk: a => `${a}.patient_id`, target: 'Patient' },
    subject: { fk: a => `${a}.patient_id`, target: 'Patient' },
    encounter: { fk: a => `${a}.encounter_id`, target: 'Encounter' },
  },
  sort: {
    date: a => `${a}.collected_at`,
  },
};

const MAPS: Record<string, TableMap> = {
  Patient: PATIENT,
  Encounter: ENCOUNTER,
  Observation: OBSERVATION,
};

export interface EmrStoreOptions {
  /** An sqb client of the EMR's database */
  client: SqbClient;
}

export class EmrStore implements FhirStore {
  private readonly _client: SqbClient;

  constructor(options: EmrStoreOptions) {
    this._client = options.client;
  }

  capabilities(type: string): StoreCapabilities | undefined {
    const map = MAPS[type];
    if (!map) return;
    return {
      interactions: ['read', 'search'],
      versions: 'none',
      searchParams: Object.keys(map.params),
      sort: Object.keys(map.sort),
      chains: target => target in MAPS,
    };
  }

  async read(type: string, id: string): Promise<StoredResource | undefined> {
    const map = MAPS[type];
    const p = new SqlParams();
    const query = Select(Raw(map.columns('t')))
      .from(`${map.table} t`)
      .where(Eq(Raw('cast(t.id as text)'), p.add(id)));
    const [row] = await this._rows(query, p);
    return row && stored(type, map.resource(row));
  }

  async search(
    type: string,
    query: SearchQuery,
  ): Promise<StorePage<StoredResource>> {
    const map = MAPS[type];
    const p = new SqlParams();
    const aliases = { n: 0 };
    const where = query.criteria.map(c =>
      this._criterion(c, map, 't', p, aliases),
    );
    const order = [
      ...query.sort.map(s => {
        const key = map.sort[s.param.code]?.('t', s.descending);
        if (!key) throw new FhirServerError(400, `No sort by ${s.param.code}`);
        return `${key} ${s.descending ? 'desc' : 'asc'} nulls last`;
      }),
      't.id',
    ].join(', ');
    const select = Select(Raw(map.columns('t')))
      .from(`${map.table} t`)
      .where(...where)
      .orderBy(Raw(order) as any)
      .limit(query.count)
      .offset(query.offset);
    const count = Select(Raw('cast(count(*) as int) as n'))
      .from(`${map.table} t`)
      .where(...where);
    const rows = await this._rows(select, p);
    const [{ n }] = await this._rows(count, p);
    return {
      items: rows.map(r => stored(type, map.resource(r))),
      total: n,
    };
  }

  /** One criterion as a condition on the row of `alias` */
  private _criterion(
    c: SearchCriterion,
    map: TableMap,
    alias: string,
    p: SqlParams,
    aliases: { n: number },
  ): Cond {
    if (c.chain) {
      const ref = map.refs[c.param.code];
      if (!ref || ref.target !== c.chain.type) return FALSE;
      const target = MAPS[ref.target];
      const a = `c${++aliases.n}`;
      return Exists(
        Select(Raw('1'))
          .from(`${target.table} ${a}`)
          .where(
            Eq(Raw(`${a}.id`), Raw(ref.fk(alias))),
            ...c.chain.criteria.map(k =>
              this._criterion(k, target, a, p, aliases),
            ),
          ),
      ) as unknown as Cond;
    }
    if (c.has) {
      const from = MAPS[c.has.type];
      const ref = from?.refs[c.param.code];
      if (!ref || MAPS[ref.target] !== map) return FALSE;
      const a = `h${++aliases.n}`;
      return Exists(
        Select(Raw('1'))
          .from(`${from.table} ${a}`)
          .where(
            Eq(Raw(ref.fk(a)), Raw(`${alias}.id`)),
            ...c.has.criteria.map(k => this._criterion(k, from, a, p, aliases)),
          ),
      ) as unknown as Cond;
    }
    const sql = map.params[c.param.code]?.(alias);
    if (!sql) throw new FhirServerError(400, `No search by ${c.param.code}`);
    if (c.components) {
      // one row is one item: every part on it
      const parts = c.components.map(k => map.params[k.param.code](alias));
      // an item with every part: an AND of IS NOT NULL, which waits for sqb
      if (c.missing !== undefined)
        throw new FhirServerError(
          400,
          `${c.param.code}:missing is not supported yet`,
          'not-supported',
        );
      return Or(
        ...c.values.map(v =>
          And(...parts.map((s, i) => s.value(v.components![i], undefined, p))),
        ),
      ) as unknown as Cond;
    }
    if (c.missing !== undefined) {
      if (!sql.present)
        throw new FhirServerError(
          400,
          `${c.param.code}:missing is not supported yet`,
          'not-supported',
        );
      return c.missing ? (Not(sql.present) as unknown as Cond) : sql.present;
    }
    const any = Or(...c.values.map(v => sql.value(v, c.modifier, p)));
    return (c.modifier === 'not' ? Not(any) : any) as unknown as Cond;
  }

  private async _rows(
    query: ReturnType<typeof Select>,
    p: SqlParams,
  ): Promise<Record<string, any>[]> {
    const result = await this._client.execute(query, {
      params: { ...p.values },
      objectRows: true,
    });
    return (result.rows ?? []) as Record<string, any>[];
  }
}

function stored(type: string, resource: Record<string, any>): StoredResource {
  return {
    type,
    id: resource.id,
    resource,
    lastUpdated: resource.meta?.lastUpdated,
  };
}
