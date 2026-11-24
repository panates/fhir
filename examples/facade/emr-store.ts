/**
 * A facade over the EMR's tables: Patient, Encounter and Observation, read,
 * searched and written through `@fhirjs/sql`. The tables are described
 * here; rows are mapped to resources and back in mapping.ts.
 */
import {
  child,
  childTable,
  code,
  composite,
  constant,
  date,
  day,
  instant,
  linked,
  number,
  period,
  quantity,
  reference,
  SqlStore,
  string,
  token,
} from '@fhirjs/sql';
import type { SqbClient } from '@sqb/connect';
import { addresses } from './addresses.js';
import { Encounter } from './entities.js';
import {
  ACT_CODE,
  CATEGORY,
  diagnosisRows,
  ENCOUNTER_STATUS,
  encounterColumns,
  encounterOf,
  encounterRow,
  GENDER,
  ICD10,
  LOINC,
  MRN,
  NATIONAL_ID,
  observationColumns,
  observationOf,
  observationRow,
  patientColumns,
  patientOf,
  patientRow,
  telecomColumns,
  telecomRows,
  UCUM,
} from './mapping.js';

export interface EmrStoreOptions {
  /** An sqb client of the EMR's database */
  client: SqbClient;
}

export class EmrStore extends SqlStore {
  constructor(options: EmrStoreOptions) {
    super({
      client: options.client,
      types: {
        Patient: {
          table: 'patients',
          lastUpdated: 'updated_at',
          select: patientColumns,
          resource: patientOf,
          row: patientRow,
          children: {
            telecoms: childTable({
              table: 'patient_telecoms',
              fk: 'patient_id',
              select: telecomColumns,
              order: a => `${a}.rank`,
              key: ['kind', 'value'],
              rows: telecomRows,
            }),
            addresses,
          },
          params: {
            identifier: token(
              code('mrn', { system: MRN }),
              code('national_id', { system: NATIONAL_ID }),
            ),
            name: string('last_name', 'first_name', 'middle_name'),
            family: string('last_name'),
            given: string('first_name', 'middle_name'),
            gender: token(code('gender', { map: GENDER })),
            birthdate: date(day('birth_date')),
            active: token(
              code('active', { map: { true: 'true', false: 'false' } }),
            ),
            // a ContactPoint's value is found with or without its system
            phone: child(
              'telecoms',
              token(code('value'), code('value', { system: 'phone' })),
              a => `${a}.kind = 'phone'`,
            ),
            email: child(
              'telecoms',
              token(code('value'), code('value', { system: 'email' })),
              a => `${a}.kind = 'email'`,
            ),
            address: child(
              'addresses',
              string('line', 'city', 'postal_code', 'country'),
            ),
            'address-city': child('addresses', string('city')),
            // a code: no system, as the memory store matches it
            'address-use': child('addresses', token(code('kind'))),
            deceased: token(
              code(
                a =>
                  `(case when ${a}.deceased_at is null then 'false' else 'true' end)`,
              ),
            ),
          },
          sort: ['family', 'birthdate', 'address-city'],
        },
        Encounter: {
          table: 'encounters',
          lastUpdated: 'updated_at',
          select: encounterColumns,
          resource: encounterOf,
          row: encounterRow,
          children: {
            // through the application's sqb entities
            diagnoses: linked(Encounter, 'diagnoses', {
              sort: ['rank'],
              key: ['code'],
              rows: diagnosisRows,
            }),
          },
          params: {
            identifier: token(
              code('encounter_no', { system: 'urn:example:encounter' }),
            ),
            patient: reference('patient_id', 'Patient'),
            subject: reference('patient_id', 'Patient'),
            status: token(code('status', { map: ENCOUNTER_STATUS })),
            class: token(
              code('kind', {
                system: ACT_CODE,
                map: { inpatient: 'IMP', outpatient: 'AMB', emergency: 'EMER' },
              }),
            ),
            date: date(period('admitted_at', 'discharged_at')),
            'reason-code': child(
              'diagnoses',
              token(code('code', { system: ICD10 })),
            ),
          },
          sort: ['date'],
        },
        Observation: {
          table: 'lab_results',
          lastUpdated: 'updated_at',
          select: observationColumns,
          resource: observationOf,
          row: observationRow,
          params: {
            patient: reference('patient_id', 'Patient'),
            subject: reference('patient_id', 'Patient'),
            encounter: reference('encounter_id', 'Encounter'),
            code: token(code('test_code', { system: LOINC })),
            category: token(constant('laboratory', { system: CATEGORY })),
            status: token(code('status')),
            date: date(instant('collected_at')),
            'value-quantity': quantity(
              number('value_numeric'),
              code('unit', { system: UCUM }),
            ),
            'code-value-quantity': composite(),
          },
          sort: ['date'],
        },
      },
    });
  }
}
