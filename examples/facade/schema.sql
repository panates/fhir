-- An EMR's own tables, not shaped as FHIR: the facade maps them (docs/decisions/facade-store.md).
-- Searches need the unaccent extension in the public schema.

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
  active         boolean not null default true,
  updated_at     timestamptz not null default now()
);

create table patient_telecoms (
  id             bigint generated always as identity primary key,
  patient_id     bigint not null references patients,
  kind           text not null check (kind in ('phone', 'email')),
  value          text not null,
  rank           int not null,                -- the order the patient gave them in
  verified_at    timestamptz,                 -- the EMR's own, not in FHIR
  unique (patient_id, kind, value)
);

create table patient_addresses (               -- a home and a work address at most
  patient_id     bigint not null references patients on delete cascade,
  kind           text not null check (kind in ('home', 'work')),
  line           text,
  city           text,
  postal_code    text,
  country        text,
  primary key (patient_id, kind)
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
  updated_at     timestamptz not null default now()
);

create table encounter_diagnoses (
  id             bigint generated always as identity primary key,
  encounter_id   bigint not null references encounters,
  code           text not null,               -- ICD-10
  rank           int not null,                -- 1 the main diagnosis
  unique (encounter_id, code)
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
