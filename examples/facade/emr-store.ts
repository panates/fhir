/**
 * A facade over the EMR's tables: Patient, Encounter and Observation, read
 * and searched through `@fhirjs/sql`. The tables are described here; the
 * rows are mapped to resources in mapping.ts.
 */
import type { SqbClient } from '@sqb/connect';
import {
  SqlStore,
  code,
  composite,
  constant,
  date,
  day,
  instant,
  number,
  period,
  quantity,
  reference,
  string,
  token,
} from '@fhirjs/sql';
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
            phone: token(code('phone'), code('phone', { system: 'phone' })),
            email: token(code('email'), code('email', { system: 'email' })),
            'address-city': string('city'),
            deceased: token(
              code(
                a =>
                  `(case when ${a}.deceased_at is null then 'false' else 'true' end)`,
              ),
            ),
          },
          sort: ['family', 'birthdate'],
        },
        Encounter: {
          table: 'encounters',
          lastUpdated: 'updated_at',
          select: encounterColumns,
          resource: encounterOf,
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
            'reason-code': token(code('diagnosis_code', { system: ICD10 })),
          },
          sort: ['date'],
        },
        Observation: {
          table: 'lab_results',
          lastUpdated: 'updated_at',
          select: observationColumns,
          resource: observationOf,
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
