import { decimalValue, onlyElements, referenceId } from '@fhirjs/sql';

/**
 * The rows of the EMR as FHIR resources, and back. Each select list gives the columns
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
  ${instant(`${a}.deceased_at`)} as deceased_at, ${a}.active,
  ${instant(`${a}.updated_at`)} as updated_at`;

/** A patient's telecoms, in the order the patient gave them */
export const telecomColumns = (a: string) => `${a}.kind, ${a}.value`;

/** A patient's addresses, home then work: read by addresses.ts */
export interface AddressRow {
  kind: 'home' | 'work';
  line: string | null;
  city: string | null;
  postal_code: string | null;
  country: string | null;
}

export function patientOf(
  r: Row,
  children: Record<string, Row[]>,
): Record<string, any> {
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
    telecom: children.telecoms.map(t => ({ system: t.kind, value: t.value })),
    gender: GENDER[r.gender],
    birthDate: r.birth_date,
    deceasedDateTime: r.deceased_at,
    address: children.addresses.map(a =>
      compact({
        use: a.kind,
        line: [a.line].filter(Boolean),
        city: a.city,
        postalCode: a.postal_code,
        country: a.country,
      }),
    ),
  });
}

export const encounterColumns = (a: string) => `
  ${a}.id::text as id, ${a}.encounter_no, ${a}.patient_id::text as patient_id, ${a}.kind,
  ${a}.status, ${instant(`${a}.admitted_at`)} as admitted_at,
  ${instant(`${a}.discharged_at`)} as discharged_at, ${a}.department, ${a}.physician,
  ${instant(`${a}.updated_at`)} as updated_at`;

/** An encounter's diagnoses, the main one first */
export const diagnosisColumns = (a: string) => `${a}.code`;

export function encounterOf(
  r: Row,
  children: Record<string, Row[]>,
): Record<string, any> {
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
    reasonCode: children.diagnoses.map(d => ({
      coding: [{ system: ICD10, code: d.code }],
    })),
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

/* Resources to rows: the mapping back, for writes */

const codeOf = (map: Record<string, string>, value: unknown) =>
  Object.keys(map).find(k => map[k] === value) ?? null;

const codingOf = (concept: any, system: string): string | undefined =>
  concept?.coding?.find((c: any) => c.system === system)?.code;

export function patientRow(r: Row): Row {
  onlyElements(r, [
    'identifier',
    'active',
    'name',
    'telecom',
    'gender',
    'birthDate',
    'deceasedDateTime',
    'address',
  ]);
  const identifier = (system: string) =>
    r.identifier?.find((i: any) => i.system === system)?.value ?? null;
  const [name] = r.name ?? [];
  return {
    mrn: identifier(MRN),
    national_id: identifier(NATIONAL_ID),
    first_name: name?.given?.[0] ?? null,
    middle_name: name?.given?.[1] ?? null,
    last_name: name?.family ?? null,
    gender: codeOf(GENDER, r.gender),
    birth_date: r.birthDate ?? null,
    deceased_at: r.deceasedDateTime ?? null,
    // the EMR's default
    active: r.active ?? true,
  };
}

export function encounterRow(r: Row): Row {
  onlyElements(r, [
    'identifier',
    'status',
    'class',
    'serviceType',
    'subject',
    'participant',
    'period',
    'reasonCode',
  ]);
  return {
    encounter_no:
      r.identifier?.find((i: any) => i.system === 'urn:example:encounter')
        ?.value ?? null,
    patient_id: referenceId(r.subject, 'Patient') ?? null,
    kind:
      Object.keys(ENCOUNTER_CLASS).find(
        k =>
          r.class?.system === ACT_CODE &&
          ENCOUNTER_CLASS[k][0] === r.class?.code,
      ) ?? null,
    status: codeOf(ENCOUNTER_STATUS, r.status),
    admitted_at: r.period?.start ?? null,
    discharged_at: r.period?.end ?? null,
    department: r.serviceType?.text ?? null,
    physician: r.participant?.[0]?.individual?.display ?? null,
  };
}

/** A patient's telecoms as rows: the rank is their order */
export function telecomRows(r: Row): Row[] {
  return (r.telecom ?? []).map((t: any, rank: number) => ({
    kind: t.system ?? null,
    value: t.value ?? null,
    rank,
  }));
}

/** An encounter's diagnoses as rows: the first is the main one */
export function diagnosisRows(r: Row): Row[] {
  return (r.reasonCode ?? []).map((c: any, i: number) => ({
    code: codingOf(c, ICD10) ?? null,
    rank: i + 1,
  }));
}

/** A patient's addresses as rows, by their use: home or work */
export function addressRows(r: Row): AddressRow[] {
  return (r.address ?? []).map((a: any) => ({
    kind: a.use,
    line: a.line?.[0] ?? null,
    city: a.city ?? null,
    postal_code: a.postalCode ?? null,
    country: a.country ?? null,
  }));
}

export function observationRow(r: Row): Row {
  onlyElements(r, [
    'status',
    'category',
    'code',
    'subject',
    'encounter',
    'effectiveDateTime',
    'issued',
    'valueQuantity',
    'valueString',
    'interpretation',
    'referenceRange',
  ]);
  const [range] = r.referenceRange ?? [];
  return {
    patient_id: referenceId(r.subject, 'Patient') ?? null,
    encounter_id: referenceId(r.encounter, 'Encounter') ?? null,
    test_code: codingOf(r.code, LOINC) ?? null,
    value_numeric: decimalValue(r.valueQuantity?.value) ?? null,
    value_text: r.valueString ?? null,
    unit: r.valueQuantity?.code ?? null,
    ref_low: decimalValue(range?.low?.value) ?? null,
    ref_high: decimalValue(range?.high?.value) ?? null,
    flag: codingOf(r.interpretation?.[0], INTERPRETATION) ?? null,
    status: r.status ?? null,
    collected_at: r.effectiveDateTime ?? null,
    reported_at: r.issued ?? null,
  };
}
