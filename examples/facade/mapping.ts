/**
 * The rows of the EMR as FHIR resources. Each select list gives the columns
 * as text where the driver would give a type of its own (dates, numbers),
 * so that the mapping does not depend on the driver.
 */

export const LOINC = 'http://loinc.org';
export const UCUM = 'http://unitsofmeasure.org';
export const ICD10 = 'http://hl7.org/fhir/sid/icd-10';
export const MRN = 'urn:example:mrn';
export const NATIONAL_ID = 'urn:example:national-id';
export const ACT_CODE = 'http://terminology.hl7.org/CodeSystem/v3-ActCode';
export const CATEGORY =
  'http://terminology.hl7.org/CodeSystem/observation-category';
export const INTERPRETATION =
  'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation';

export const GENDER: Record<string, string> = {
  M: 'male',
  F: 'female',
  O: 'other',
  U: 'unknown',
};
export const ENCOUNTER_STATUS: Record<string, string> = {
  planned: 'planned',
  in_progress: 'in-progress',
  finished: 'finished',
  cancelled: 'cancelled',
};
export const ENCOUNTER_CLASS: Record<string, [string, string]> = {
  inpatient: ['IMP', 'inpatient encounter'],
  outpatient: ['AMB', 'ambulatory'],
  emergency: ['EMER', 'emergency'],
};
const FLAG: Record<string, [string, string]> = {
  H: ['H', 'High'],
  L: ['L', 'Low'],
  N: ['N', 'Normal'],
};

/** An instant column as FHIR writes it, in UTC with milliseconds */
export const instant = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

type Row = Record<string, any>;

const compact = <T extends Record<string, any>>(o: T): T => {
  for (const k of Object.keys(o))
    if (
      o[k] === null ||
      o[k] === undefined ||
      (Array.isArray(o[k]) && !o[k].length)
    )
      delete o[k];
  return o;
};

export const patientColumns = (a: string) => `
  ${a}.id::text as id, ${a}.mrn, ${a}.national_id, ${a}.first_name, ${a}.middle_name,
  ${a}.last_name, ${a}.gender, ${a}.birth_date::text as birth_date,
  ${instant(`${a}.deceased_at`)} as deceased_at, ${a}.phone, ${a}.email,
  ${a}.address_line, ${a}.city, ${a}.postal_code, ${a}.country, ${a}.active,
  ${instant(`${a}.updated_at`)} as updated_at`;

export function patientOf(r: Row): Record<string, any> {
  return compact({
    resourceType: 'Patient',
    id: r.id,
    meta: { lastUpdated: r.updated_at },
    identifier: [
      { system: MRN, value: r.mrn },
      r.national_id && { system: NATIONAL_ID, value: r.national_id },
    ].filter(Boolean),
    active: r.active,
    name: [
      compact({
        family: r.last_name,
        given: [r.first_name, r.middle_name].filter(Boolean),
      }),
    ],
    telecom: [
      r.phone && { system: 'phone', value: r.phone },
      r.email && { system: 'email', value: r.email },
    ].filter(Boolean),
    gender: GENDER[r.gender],
    birthDate: r.birth_date,
    deceasedDateTime: r.deceased_at,
    address: [
      compact({
        line: [r.address_line].filter(Boolean),
        city: r.city,
        postalCode: r.postal_code,
        country: r.country,
      }),
    ],
  });
}

export const encounterColumns = (a: string) => `
  ${a}.id::text as id, ${a}.encounter_no, ${a}.patient_id::text as patient_id, ${a}.kind,
  ${a}.status, ${instant(`${a}.admitted_at`)} as admitted_at,
  ${instant(`${a}.discharged_at`)} as discharged_at, ${a}.department, ${a}.physician,
  ${a}.diagnosis_code, ${instant(`${a}.updated_at`)} as updated_at`;

export function encounterOf(r: Row): Record<string, any> {
  const [code, display] = ENCOUNTER_CLASS[r.kind];
  return compact({
    resourceType: 'Encounter',
    id: r.id,
    meta: { lastUpdated: r.updated_at },
    identifier: [{ system: 'urn:example:encounter', value: r.encounter_no }],
    status: ENCOUNTER_STATUS[r.status],
    class: { system: ACT_CODE, code, display },
    serviceType: r.department ? { text: r.department } : undefined,
    subject: { reference: `Patient/${r.patient_id}` },
    participant: r.physician
      ? [{ individual: { display: r.physician } }]
      : undefined,
    period:
      r.admitted_at || r.discharged_at
        ? compact({ start: r.admitted_at, end: r.discharged_at })
        : undefined,
    reasonCode: r.diagnosis_code
      ? [{ coding: [{ system: ICD10, code: r.diagnosis_code }] }]
      : undefined,
  });
}

export const observationColumns = (a: string) => `
  ${a}.id::text as id, ${a}.patient_id::text as patient_id,
  ${a}.encounter_id::text as encounter_id, ${a}.test_code,
  (select lt.name from lab_tests lt where lt.code = ${a}.test_code) as test_name,
  ${a}.value_numeric::float8 as value_numeric, ${a}.value_text, ${a}.unit,
  ${a}.ref_low::float8 as ref_low, ${a}.ref_high::float8 as ref_high, ${a}.flag, ${a}.status,
  ${instant(`${a}.collected_at`)} as collected_at,
  ${instant(`${a}.reported_at`)} as reported_at, ${instant(`${a}.updated_at`)} as updated_at`;

const quantity = (value: number | null, unit: string | null) =>
  value === null
    ? undefined
    : compact({
        value,
        unit,
        system: unit ? UCUM : undefined,
        code: unit,
      });

export function observationOf(r: Row): Record<string, any> {
  return compact({
    resourceType: 'Observation',
    id: r.id,
    meta: { lastUpdated: r.updated_at },
    status: r.status,
    category: [
      {
        coding: [
          { system: CATEGORY, code: 'laboratory', display: 'Laboratory' },
        ],
      },
    ],
    code: {
      coding: [{ system: LOINC, code: r.test_code, display: r.test_name }],
    },
    subject: { reference: `Patient/${r.patient_id}` },
    encounter: r.encounter_id
      ? { reference: `Encounter/${r.encounter_id}` }
      : undefined,
    effectiveDateTime: r.collected_at,
    issued: r.reported_at,
    valueQuantity: quantity(r.value_numeric, r.unit),
    valueString: r.value_numeric === null ? r.value_text : undefined,
    interpretation: r.flag
      ? [
          {
            coding: [
              {
                system: INTERPRETATION,
                code: FLAG[r.flag][0],
                display: FLAG[r.flag][1],
              },
            ],
          },
        ]
      : undefined,
    referenceRange:
      r.ref_low !== null || r.ref_high !== null
        ? [
            compact({
              low: quantity(r.ref_low, r.unit),
              high: quantity(r.ref_high, r.unit),
            }),
          ]
        : undefined,
  });
}
