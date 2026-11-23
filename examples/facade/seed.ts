/**
 * Seed rows of the EMR: about 20 patients, 40 encounters and 200 lab
 * results, the same on every run, with the cases a search must tell apart
 * (a family name that begins another, a patient without a birth date, a
 * deceased one, accents, results with and without a unit or an encounter).
 */

export interface Rows {
  patients: Record<string, unknown>[];
  encounters: Record<string, unknown>[];
  lab_tests: Record<string, unknown>[];
  lab_results: Record<string, unknown>[];
}

/** A small generator of the same numbers on every run */
function random(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const hours = (iso: string, h: number) =>
  new Date(Date.parse(iso) + h * 3600_000).toISOString();

export function seedRows(): Rows {
  const rnd = random(42);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];

  const named: [string, string | null, string, string, string | null][] = [
    ['Ali', null, 'Yilmaz', 'M', '1980-05-12'],
    ['Alice', null, 'Smith', 'F', '1990-02-01'],
    ['Alicia', 'Ann', 'Smithers', 'F', '1985-11-30'],
    ['Mehmet', null, 'Öztürk', 'M', '1975-07-04'],
    ['John', null, 'Doe', 'M', null],
    ['Jane', 'Mary', 'Doe', 'F', '1950-01-01'],
    ['Zoë', null, 'Brown', 'F', '2001-09-15'],
    ['Sam', null, 'Taylor', 'O', '1999-12-31'],
    ['Robin', null, 'Lee', 'U', '2010-06-06'],
    ['Ayşe', 'Nur', 'Kaya', 'F', '1968-03-21'],
  ];
  const firsts = ['Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'Elif', 'Can'];
  const lasts = ['Smith', 'Johnson', 'Demir', 'Garcia', 'Smithson', 'Kaya'];
  const cities = ['Istanbul', 'Ankara', 'Izmir', 'London', 'Boston'];
  const patients: Record<string, unknown>[] = [];
  for (let i = 0; i < 20; i++) {
    const [first, middle, last, gender, birth] =
      named[i] ??
      ([
        pick(firsts),
        rnd() < 0.3 ? pick(firsts) : null,
        pick(lasts),
        pick(['M', 'F']),
        `19${50 + Math.floor(rnd() * 50)}-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}`,
      ] as const);
    const n = i + 1;
    patients.push({
      mrn: `MRN${String(n).padStart(4, '0')}`,
      national_id: n % 4 === 0 ? null : String(10000000000 + n * 137),
      first_name: first,
      middle_name: middle,
      last_name: last,
      gender,
      birth_date: birth,
      deceased_at: n === 6 ? '2020-06-01T10:00:00.000Z' : null,
      phone: n % 3 === 0 ? null : `+90555000${String(n).padStart(4, '0')}`,
      email: n % 5 === 0 ? null : `${first.toLowerCase()}.${n}@example.org`,
      address_line: `${n} Main Street`,
      city: n % 7 === 0 ? null : cities[n % cities.length],
      postal_code: String(34000 + n),
      country: n % 2 ? 'TR' : 'GB',
      active: n !== 8,
      updated_at: hours('2026-01-01T00:00:00.000Z', n * 5),
    });
  }

  const kinds = ['inpatient', 'outpatient', 'emergency'];
  const departments = ['Cardiology', 'Internal Medicine', 'Emergency'];
  const encounters: Record<string, unknown>[] = [];
  for (let i = 0; i < 40; i++) {
    const n = i + 1;
    const patient = (i % 20) + 1;
    const kind = kinds[i % 3];
    const start = hours('2025-01-01T08:00:00.000Z', n * 97);
    // planned without dates, planned ahead, still in hospital, finished,
    // cancelled; encounter 1 a long stay, over the next ones; encounter 2 an old
    // record with its end only
    const status =
      n === 40
        ? 'planned'
        : n % 13 === 0
          ? 'cancelled'
          : n % 9 === 0
            ? 'in_progress'
            : n % 11 === 0
              ? 'planned'
              : 'finished';
    encounters.push({
      encounter_no: `ENC${String(n).padStart(5, '0')}`,
      patient_id: patient,
      kind,
      status,
      admitted_at: n === 40 || n === 2 ? null : start,
      discharged_at:
        status === 'finished' || status === 'cancelled'
          ? hours(start, n === 1 ? 400 : kind === 'inpatient' ? 72 : 4)
          : null,
      department: departments[i % 3],
      physician: `Dr. ${pick(lasts)}`,
      diagnosis_code: pick(['I10', 'E11.9', 'J18.9', 'R07.4', null]),
      updated_at: hours('2026-02-01T00:00:00.000Z', n * 3),
    });
  }

  const lab_tests = [
    { code: '2339-0', name: 'Glucose [Mass/volume] in Blood', unit: 'mg/dL' },
    { code: '718-7', name: 'Hemoglobin [Mass/volume] in Blood', unit: 'g/dL' },
    {
      code: '2160-0',
      name: 'Creatinine [Mass/volume] in Serum',
      unit: 'mg/dL',
    },
    { code: '2951-2', name: 'Sodium [Moles/volume] in Serum', unit: 'mmol/L' },
    { code: '5778-6', name: 'Color of Urine', unit: null },
  ];
  const ranges: Record<string, [number, number, number]> = {
    '2339-0': [70, 100, 60], // low, high, spread
    '718-7': [12, 17, 6],
    '2160-0': [0.6, 1.3, 1],
    '2951-2': [135, 145, 15],
  };
  const lab_results: Record<string, unknown>[] = [];
  for (let i = 0; i < 200; i++) {
    const encounter = (i % 40) + 1;
    const e = encounters[encounter - 1];
    const test = lab_tests[i % 5];
    const range = ranges[test.code];
    const value = range
      ? Math.round((range[0] + (rnd() - 0.3) * range[2]) * 10) / 10
      : null;
    const at = e.admitted_at
      ? hours(e.admitted_at as string, 1 + (i % 7))
      : null;
    lab_results.push({
      patient_id: e.patient_id,
      encounter_id: i % 17 === 0 ? null : encounter,
      test_code: test.code,
      value_numeric: value,
      value_text: range ? null : pick(['yellow', 'amber', 'red']),
      // some numeric results come without their unit
      unit: range && i % 23 !== 0 ? test.unit : null,
      ref_low: range?.[0] ?? null,
      ref_high: range?.[1] ?? null,
      flag:
        value === null
          ? null
          : value < range![0]
            ? 'L'
            : value > range![1]
              ? 'H'
              : 'N',
      status:
        i % 29 === 0 ? 'preliminary' : i % 31 === 0 ? 'cancelled' : 'final',
      collected_at: at,
      reported_at: at && hours(at, 2),
      updated_at: hours('2026-03-01T00:00:00.000Z', i + 1),
    });
  }
  return { patients, encounters, lab_tests, lab_results };
}
