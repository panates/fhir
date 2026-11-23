# A helper for SQL facades

The design of a package that turns a description of an existing database's tables into a
`FhirStore`: reads and searches translated to SQL with sqb. [`server.md`](server.md) left it
until a first real facade existed; [`facade-store.md`](facade-store.md) built one in
`examples/facade` and listed what a helper would take over ("Built", "What the helper would take
over"). This document turns that list into a package.

## Decided (2026-11-23)

| Question  | Decision                                                     | Why                                                                                                                   |
| --------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Package   | `@fhirjs/sql` in `packages/sql`                              | Next to `@fhirjs/server`; the name says what it adds.                                                                 |
| Databases | PostgreSQL only, its own SQL kept in one `SqlDialect` object | One database built and tested well; another is a second dialect object, not a rewrite.                                |
| sqb       | A peer dependency (`@sqb/builder`, `@sqb/connect`)           | The application picks sqb's version and its dialect package, and has one copy of sqb.                                 |
| Base URL  | The server strips its own base from reference values         | Every store finds the server's own absolute references without knowing the base; references elsewhere keep their URL. |

## What the facade showed

- **The translators were the same for every table**: a token over code columns, a string over
  text columns, a date over an instant, a date or a period, a quantity over a number and a unit,
  a reference over a foreign key. `sql-search.ts` holds them, about 300 lines; each table names
  them per parameter in a few lines.
- **Chains, `_has` and composites need nothing per table** beyond the foreign keys: `EXISTS` on
  the target's table, and the `AND` of a composite's parts on one row.
- **Two cases a column name does not cover**: a value computed in SQL (`deceased`, from whether
  `deceased_at` is null) and a column of another table (the test's name, by a subquery). An SQL
  expression where a column goes covers both.
- **The mapping of a row to a resource is code**: codes of the EMR's own (`M` to `male`), a name
  in three columns, a value in two. A declarative mapping would be a language of its own.
- **The store does not know the server's base URL**, so an absolute reference to the server
  itself (`subject=http://host/fhir/Patient/1`) is not found.
- **Each translator's meaning was checked against the memory store** (140 searches), and the
  checks found what reading the specification did not. The helper keeps that test.

## Proposal

### The package

`@fhirjs/sql` in `packages/sql`: `SqlStore`, the column kinds, and the translators. It depends
on `@fhirjs/server`; sqb (`@sqb/builder`, `@sqb/connect`) is a peer dependency, so the
application chooses its version and its dialect package. PostgreSQL first: the SQL that depends
on the database (accents removed with `unaccent`, `date_trunc`, intervals, `collate "C"`) is in
one `SqlDialect` object, so another database is a second object, not a rewrite.

### A table description

```ts
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

const store = new SqlStore({
  client, // an SqbClient
  types: {
    Patient: {
      table: 'patients',
      id: 'id',
      lastUpdated: 'updated_at',
      select: a => `${a}.id::text as id, ${a}.mrn, ...`, // the columns resource() reads
      resource: patientOf, // a row to a resource: the application's code
      params: {
        identifier: token(
          code('mrn', { system: MRN }),
          code('national_id', { system: NATIONAL_ID }),
        ),
        name: string('last_name', 'first_name', 'middle_name'),
        family: string('last_name'),
        gender: token(code('gender', { map: GENDER })),
        birthdate: date(day('birth_date')),
        phone: token(code('phone'), code('phone', { system: 'phone' })),
        deceased: token(
          code(
            a =>
              `case when ${a}.deceased_at is null then 'false' else 'true' end`,
          ),
        ),
      },
      sort: ['family', 'birthdate'],
    },
    Encounter: {
      table: 'encounters',
      // ...
      params: {
        patient: reference('patient_id', 'Patient'),
        date: date(period('admitted_at', 'discharged_at')),
      },
      sort: ['date'],
    },
    Observation: {
      table: 'lab_results',
      // ...
      params: {
        code: token(code('test_code', { system: LOINC })),
        category: token(constant('laboratory', { system: CATEGORY })),
        'value-quantity': quantity(
          number('value_numeric'),
          code('unit', { system: UCUM }),
        ),
        // a composite: its parts' parameters, on one row
        'code-value-quantity': composite(),
      },
    },
  },
});
```

- **A column** is a name (on the row's alias) or a function of the alias giving an SQL
  expression: the computed value and the subquery are both expressions.
- **The kinds of a column**: `code` (a token's code, with a system and a map of the database's
  codes to FHIR's, or a constant), `string`, `instant`, `day`, `period` (two instants, either
  open), `number`, and a quantity of a number and a unit. Each kind knows its `:missing` (an
  `IS NOT NULL` per column, ORed) and its sort key.
- **A reference parameter names its foreign key and its target**; chains and `_has` follow it.
  The `refs` of the example go.
- **A composite** is named with `composite()` and answered from its components' parameters on one row (one row is one item),
  with `:missing` as the `AND` of their parts; a table that keeps a composite's parts in other
  rows names its own translator.
- **`sort`** names the parameters to sort by; the key comes from the column's kind (a period's
  start ascending, its end descending, the other end where one is missing; a string's normalized
  text in `collate "C"`; a token's FHIR code over one column; a reference's `Type/id`). A
  parameter over several string columns needs a key of its own: `{ param, key }`.
- **Its own translator**: any parameter can be a function `(ctx, criterion) => Cond` (`ctx` has
  the row's alias, the query's parameters and the dialect),
  for what the kinds do not cover.
- **What the store declares** comes from the description: `read` and `search`, `versions:
'none'`, the parameters, the sort keys, chains to its own types.

### Searching

As in the example: criteria become one `WHERE`, values of a criterion `OR`, criteria `AND`;
`:not` keeps the rows without a value; chains and `_has` are `EXISTS`, nested to any depth;
`LIMIT` and `OFFSET`, then a count of the same condition; values always go as parameters. Refused
with 400: `:text`, `:above` and `:below`, the prefix `ap` of a date. A criterion on a parameter
the description does not name never reaches the store: the server refuses it from `searchParams`.

### The base URL (a server change)

The server strips its own base from a reference value before the store sees it:
`subject=http://host/fhir/Patient/1` reaches the store as `Patient/1`, without `url`. Every store
then finds its own references, the memory store as before, and none needs the base. Absolute
references to other servers keep their `url`, and the SQL store finds nothing for them.

## Tests

- **`examples/facade` moves to the helper**, its `sql-search.ts` removed and `emr-store.ts`
  reduced to a description. The 140 differential searches and the refusals stay as they are and
  must pass unchanged: they are the measure that the helper means what the example meant.
- **The package's own tests** run a second, smaller schema of different shape against the memory
  store the same way: a code in its own table, a quantity whose unit is a constant, a parameter
  with its own translator. They need `FHIR_PG_URL` and skip without it.
- **The server change** gets a test of its own: a local absolute reference finds the resource on
  the memory store and on the facade.
- **Control runs** as for the other steps.

## Built (2026-11-23)

`packages/sql`: `columns.ts` (the kinds and their translators), `dialect.ts` (`SqlDialect` and
`postgres`), `sql-store.ts` (`SqlStore`). The server strips its own base from reference values
(`localReferences` in `fhir-server.ts`). `examples/facade` is a description now (`emr-store.ts`,
125 lines), its `sql-search.ts` gone.

- **The example's 140 searches pass unchanged** on the helper, with two added: an absolute
  reference to the server, found now, and one to another server, not found.
- **The package's own tests** run a second schema against the memory store the same way (39
  searches, 11 sorts): an id column named otherwise (`person_no`), a code in a table of its own
  (by a subquery), a unit every row shares (`constant`), a parameter by code of its own
  (`identifier`). The database's codes and ids sort otherwise than FHIR's, so that a key taken
  from the column instead of the FHIR value is caught.
- **What changed from the proposal**: no `sql` tag (an expression is a string), a composite is
  named with `composite()` (the store must list it in `searchParams`), `_id` and `_lastUpdated`
  come from `id` and `lastUpdated`, and a sort key the kind does not have is refused when the
  store is made.
- **Control runs**, each caught: the server keeping its own URL, a token sorted by the
  database's code, a reference sorted by number, a string sorted without normalizing, the unit
  ignored, a chain and `_has` on `id` instead of the table's id column, a date sorted by its
  start descending, `:missing` of a token over its last column only, a composite's `:missing` as
  an `OR`, a parameter of its own skipped.

## Not in this step

Writes (create, update, delete) and the mapping back from a resource to rows, history and
versions, transactions, a terminology server, other databases than PostgreSQL (the dialect object
leaves room), and generating a description from a database's catalog.
