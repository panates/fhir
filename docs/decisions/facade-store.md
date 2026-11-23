# A first facade store

The design of a first store over a real database: an EMR's own tables, mapped to FHIR on the way
out, with searches translated to SQL. It is written before the code, to find what a SQL helper
for facades would need. [`server.md`](server.md) leaves that helper until a first real facade
exists ("A helper for SQL facades (on sqb) may follow once a first real facade is written").

## Decided (2026-11-22)

| Question | Decision | Why |
| -------- | -------- | --- |
| Database | A small PostgreSQL schema of our own, shaped like an EMR, with English column names and seed data | It runs in CI and on any machine, and it is the shape a facade usually meets: rows and columns close to FHIR without being FHIR. |
| Where it lives | `examples/facade`, run by tests; nothing published | The parts worth reusing become a package once they are seen, not before. |
| SQL layer | sqb (`@sqb/builder`, `@sqb/connect`, `@sqb/postgres`) | Panates' own builder; the later helper is built on it. Conditions are built as objects, so a parsed criterion becomes a condition without string concatenation. |
| Scope | Patient, Encounter and Observation (lab results): read and search, no writes | Three tables with references between them test chains, `_has` and a composite (`code-value-quantity`). Writes come after the reads have shown how mapping goes. |

## The schema

```sql
create table patients (
  id             bigint generated always as identity primary key,
  mrn            text not null unique,        -- medical record number
  national_id    text unique,
  first_name     text not null,
  middle_name    text,
  last_name      text not null,
  gender         char(1) not null,            -- M, F, O, U
  birth_date     date,
  deceased_at    timestamptz,
  phone          text,
  email          text,
  address_line   text,
  city           text,
  postal_code    text,
  country        text,
  active         boolean not null default true,
  updated_at     timestamptz not null default now()
);

create table encounters (
  id             bigint generated always as identity primary key,
  encounter_no   text not null unique,
  patient_id     bigint not null references patients,
  kind           text not null,               -- inpatient, outpatient, emergency
  status         text not null,               -- planned, in_progress, finished, cancelled
  admitted_at    timestamptz,
  discharged_at  timestamptz,
  department     text,
  physician      text,
  diagnosis_code text,                        -- ICD-10
  updated_at     timestamptz not null default now()
);

create table lab_tests (                      -- the catalogue
  code           text primary key,            -- LOINC
  name           text not null,
  unit           text                         -- UCUM
);

create table lab_results (
  id             bigint generated always as identity primary key,
  patient_id     bigint not null references patients,
  encounter_id   bigint references encounters,
  test_code      text not null references lab_tests,
  value_numeric  numeric,
  value_text     text,
  unit           text,
  ref_low        numeric,
  ref_high       numeric,
  flag           char(1),                     -- H, L, N
  status         text not null,               -- registered, preliminary, final, amended, cancelled
  collected_at   timestamptz,
  reported_at    timestamptz,
  updated_at     timestamptz not null default now()
);
```

The columns differ from FHIR on purpose: codes of its own (`M`, `in_progress`, `inpatient`), a
name in three columns, an address in one line, a result's value in two columns, the test's name
in another table. Seed data: about 20 patients, 40 encounters and 200 results, with the cases a
search must tell apart (a family name that is a prefix of another, a patient with no birth date,
results with and without a unit, a deceased patient).

## The mapping

| FHIR | From |
| ---- | ---- |
| `Patient.id` | `patients.id`, as text |
| `Patient.identifier` | `mrn` (system `urn:example:mrn`), `national_id` (system `urn:example:national-id`) |
| `Patient.name` | `last_name` as `family`; `first_name` and `middle_name` as `given` |
| `Patient.gender` | `M` male, `F` female, `O` other, `U` unknown |
| `Patient.birthDate`, `deceasedDateTime` | `birth_date`, `deceased_at` |
| `Patient.telecom`, `address` | `phone`, `email`; `address_line`, `city`, `postal_code`, `country` |
| `Patient.active`, `meta.lastUpdated` | `active`, `updated_at` |
| `Encounter.identifier`, `subject` | `encounter_no`; `Patient/{patient_id}` |
| `Encounter.status` | `planned`, `in_progress` as `in-progress`, `finished`, `cancelled` |
| `Encounter.class` | `inpatient` IMP, `outpatient` AMB, `emergency` EMER (v3 ActCode) |
| `Encounter.period` | `admitted_at` to `discharged_at` |
| `Encounter.serviceType`, `participant`, `reasonCode` | `department` as text, `physician` as a display, `diagnosis_code` in ICD-10 |
| `Observation.category`, `code` | `laboratory`; LOINC `test_code` with `lab_tests.name` as its display |
| `Observation.subject`, `encounter` | `Patient/{patient_id}`, `Encounter/{encounter_id}` |
| `Observation.value[x]` | `valueQuantity` from `value_numeric` and `unit` (UCUM), or `valueString` from `value_text` |
| `Observation.interpretation`, `referenceRange` | `flag` in v3 ObservationInterpretation; `ref_low`, `ref_high` |
| `Observation.status`, `effectiveDateTime`, `issued` | `status`; `collected_at`; `reported_at` |

The store declares `versions: 'none'` (the tables keep no versions), the interactions `read` and
`search`, `chains` to its own three types, and `sort`. It gives `meta.lastUpdated`, without a
`versionId`.

## Searches

Each type names the parameters it answers in `searchParams`; the server refuses the others.

| Type | Parameters |
| ---- | ---------- |
| Patient | `_id`, `_lastUpdated`, `identifier`, `name`, `family`, `given`, `gender`, `birthdate`, `active`, `phone`, `email`, `address-city`, `deceased` |
| Encounter | `_id`, `_lastUpdated`, `identifier`, `patient`, `subject`, `status`, `class`, `date`, `reason-code` |
| Observation | `_id`, `_lastUpdated`, `patient`, `subject`, `encounter`, `code`, `category`, `status`, `date`, `value-quantity`, `code-value-quantity` |

- **A criterion becomes a sqb condition**, by the kind of column behind the parameter, not by
  the parameter: a token over a code column with a code map (`gender`, `status`), a token over
  identifier columns chosen by system, a string over several columns (`name` over three, with
  `ILIKE 'x%'`, `:exact`, `:contains`; FHIR also ignores accents, which needs PostgreSQL's
  `unaccent` on both sides), a date over one column or over a period of two (`date`
  of an Encounter: the period overlaps the value's range, with the prefixes), a quantity over a
  number and a unit column, a reference over a foreign key. Values of one criterion are `OR`,
  criteria `AND`.
- **`:missing`** is `IS NULL` / `IS NOT NULL`; **`:not`** is `NOT (...)` with the rows whose
  column is null kept, as FHIR asks. `:text` and `:above`/`:below` are refused (400) by the store.
- **Chains and `_has`** become `EXISTS` subqueries: `Observation?subject:Patient.name=ali` is
  `EXISTS (SELECT 1 FROM patients p WHERE p.id = lab_results.patient_id AND <name>)`,
  `Patient?_has:Observation:patient:code=2339-0` the other way round. Nesting follows the chain.
- **`code-value-quantity`** is the `AND` of its parts on one row: a result is one row.
- **`_sort`**: Patient by `family`, `birthdate`; Encounter by `date`; Observation by `date`,
  each with `NULLS LAST`, then by `id` so that pages are stable.
- **Paging and total:** `LIMIT` and `OFFSET`, and a `COUNT(*)` of the same condition.
- **`_include`, `_revinclude`, `_summary`, `_elements`** need nothing of the store: the server
  does them with `read` and `search`.

## Where it is used

```ts
const emr = new EmrStore({ client: new SqbClient({ dialect: 'postgres', ... }) });
new FhirServer({ fhir, store: emr, resources: ['Patient', 'Encounter', 'Observation'] });
// or next to a FHIR store for the other types
new FhirServer({
  fhir,
  store: new RoutingStore({
    store: new MemoryStore(),
    routes: { Patient: emr, Encounter: emr, Observation: emr },
  }),
});
```

## Tests

- **Against the memory store.** The seed rows are mapped to resources and put in a
  `MemoryStore`. A list of search URLs (each parameter, modifier, prefix, chain, `_has`, the
  composite, sorting and paging) runs on both servers, and the ids and their order must be the
  same. The memory store matches by FHIRPath, so the SQL is checked against the meaning of each
  parameter rather than against SQL written twice.
- **Reads:** each mapped resource is valid against R4, and a read gives what the mapping gives.
- **Refusals:** a parameter the store does not name, `:text`, a write (405).
- **PostgreSQL:** the tests make a schema of their own (`facade_<random>`), seed it and drop it.
  They read the connection from `FHIR_PG_URL`, by default `postgres://postgres@localhost:5432`,
  and skip when no database answers, as the tests that need the HL7 packages do. CI's `test` job
  gets a `postgres` service, as sqb's own CI has.
- **Control runs** as for the other steps: a prefix ignored, `:not` dropping nulls, a chain
  without its condition, the composite on two rows; tests must fail each time.

## What to look for

The point of the example is what a helper would take over. Notes kept while building it go in a
"Built" section here: which translators were the same for every table (a token over a code
column, a date over a period), what the mapping needed that a declarative table description
cannot say, and what sqb lacked, if anything (reported to its maintainers, not worked around).

## Not in this step

Writes (create, update, delete), history and versions, transactions, a terminology server for
the codes, and other databases than PostgreSQL.
