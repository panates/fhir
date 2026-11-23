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
leaves room), and generating a description from a database's catalog. _Writes, versions of the
current row and transactions came next: see "Writes"._

## Writes (2026-11-23)

### Decided

| Question              | Decision                                                                                                           | Why                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| The mapping back      | A function of the table, `row(resource, db)`, to its columns: the inverse of `resource(row)`                       | The mapping is code in both directions (codes of the EMR's own, a name in three columns); no language of its own.         |
| An element not kept   | Refused (422) twice: first by `row()` (`onlyElements()`), then by the store, which reads the row back and compares | [`server.md`](server.md): a facade refuses what it cannot keep rather than drop it. The second check needs no table code. |
| Versions and If-Match | `versions: 'current'` for a table that is written and names `lastUpdated` as a column; `'none'` otherwise          | The column is there in most EMRs; no change to the schema. A table without it keeps no version.                           |
| Transactions          | `transaction()`: one connection, `BEGIN`, the view's reads and writes on it, `COMMIT` or `ROLLBACK`                | A transaction Bundle over the existing tables is all or nothing, as the server asks of a store.                           |

### Built

- **`row(resource, db)`** gives every column it maps, null where the resource has no value (an
  update replaces the resource); `db.rows(sql, params)` runs SQL in the write's transaction, for a
  code kept in a table of its own. Without `row()`, a type is read-only (405 from the server).
  Helpers: `onlyElements(resource, names)` refuses a top-level element without a column,
  `referenceId(ref, type)` gives the id of `Type/id` and refuses anything else, `decimalValue(v)`
  gives a decimal's text (`13.40`) for a numeric column.
- **Every write is a database transaction**: the row locked (`select ... for update`), If-Match
  checked, `INSERT ... RETURNING` the id or `UPDATE`, then the row read back with `resource()`.
  An element of the written resource that is not in the one read back fails the write (422,
  rolled back), with its path: `Patient.name[0]`, `Observation.code.coding[0]`. Instants are
  compared as times (`+03:00` is kept as the same instant in UTC), decimals as numbers, the items
  of an array in any order; the read resource may have more (a display from a catalogue).
- **Versions**: the store sets the `lastUpdated` column on every write; the versionId is its
  milliseconds since 1970, read with every row, also in searches. An update takes at least the
  current version plus one, so two writes within a millisecond are two versions.
- **The database's refusals** become the client's answer, without the database's names: a unique
  key 409, a row still referred to on delete 409, a foreign key to no row 422, a null, a check or
  a value of the wrong form 422. The SQLSTATEs are read by the dialect (`refusal()`).
- **The ids are the database's** (`acceptsIds` is not declared, nor `updateCreate`), so a
  transaction cannot refer to a new resource by its fullUrl; the server refuses it (400).
- **`examples/facade` writes** Patient, Encounter and Observation (`patientRow`, `encounterRow`,
  `observationRow` in `mapping.ts`). Every one of its 260 seed rows, read and written back by
  update, comes back unchanged: the mapping back is the inverse of the mapping.

### Tests and control runs

`packages/sql/test/sql-writes.spec.ts` runs a third schema through a server (a versioned table, an
unversioned one with its code in a table of its own, a read-only one): create, update, delete,
If-Match, 14 refusals with the rows counted before and after, a transaction Bundle that fails
after a write and one that commits. `examples/facade` adds the 260 writes back, a patient and an
encounter created, updated and deleted, a decimal's trailing zero kept, and a transaction.

Control runs, each caught: the read-back check off, `onlyElements()` off, If-Match ignored, the
version not past the current one, a refused write committed, the transaction's view on the pool,
an array's item matched twice, instants compared as text, a decimal written as a number, a
referred row's delete as 422, a read-only table declared written, every written table versioned,
`lastUpdated` not set, a unique key not answered 409.

### Not in this step

History and older versions (`vread`), ids given by the client or the server (a transaction's
placeholders), conditional writes beyond what the server does over search, and a resource kept in
more than one row (a patient's several addresses). _Child tables came next: see "Child tables"._

## Child tables (2026-11-23)

A resource over more than one row: a patient's telecoms and addresses, an encounter's diagnoses.

### Decided

| Question            | Decision                                                                                                                                  | Why                                                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One way or several  | The store asks a child for four things (`SqlChild`: `read`, `join`, `write`, `remove`); how a child does them is its own                  | No single way fits every EMR (the user's view): a plain child table, SQL of the application's own (an upsert, EAV, a JSON column), or sqb's ORM where the schema suits it. They are mixed. |
| Reading             | The store asks each child for the rows of a whole page at once (`read(parentIds)`), and gives them to `resource(row, children)` by parent | One query a child a page, not one a row; the values come from the driver with their types (a JSON aggregate would turn `13.40` into `13.4`); no SQL of one database in the description.    |
| Writing             | `childTable()` matches rows by a key: the same key updated, a new one inserted, one gone deleted                                          | A kept row keeps its id and the columns FHIR does not see (`verified_at` of a telecom). Without a key, the rows are deleted and inserted again.                                            |
| Searching           | `child(name, param, where?)` wraps a parameter of any kind: `EXISTS` a row of the child that matches                                      | `:missing` and `:not` work as on a column (`NOT EXISTS`); a sort takes the lowest of a resource's rows ascending, the highest descending, as FHIR asks.                                    |
| sqb's ORM (`@Link`) | A child over sqb entities is a later step                                                                                                 | It needs sqb's filters and projections joined to the parameters' SQL; a separate piece of work.                                                                                            |

### Built

- **`SqlChild`** (`packages/sql/src/children.ts`): `read(parentIds, db)` gives the rows of each
  parent in their order; `join(parentId, alias)` gives the table and the condition, for searches;
  `write(parentId, resource, db)` writes the parent's rows after the parent's row; `remove()`
  deletes them before the parent (not needed when the foreign key cascades). A child without
  `write` is read only: a resource that changes its rows is refused by the read back.
- **`childTable({ table, fk, select, order, key, rows })`** is a child over a table with a foreign
  key to the parent. Two rows of a resource with one key are refused (422).
- **`SqlTable.children`** names the children; `resource(row, children)` takes their rows. The
  store reads the parent's id with every row for them, writes the children in the write's
  transaction, and the read back covers their rows too.
- **`examples/facade`** keeps telecoms (`patient_telecoms`, by kind and value) and diagnoses
  (`encounter_diagnoses`, by code) with `childTable()`, and addresses (`patient_addresses`, a home
  and a work address at most) with a child of its own SQL in `addresses.ts`: an array of ids, an
  upsert, a cascading foreign key. New parameters: `address`, `address-use`, and a sort by
  `address-city`.

### Tests and control runs

`examples/facade`: 16 more searches against FHIRPath (a second phone, a work address's city, two
diagnoses, `:missing` and `:not` over child rows, a sort by the lowest and the highest city), the
260 rows written back unchanged, and a test of key matching: the rows' ids and `verified_at` kept
when the phones are swapped, a changed email inserted and the old one deleted, a diagnosis
removed, five refusals that write nothing, and a patient deleted with its rows.
`packages/sql/test/sql-children.spec.ts`: a child without a key, a child that is only read,
searches and sorts over child rows a page at a time, and a `child()` that names no child.

Control runs, each caught: key matching off, children not written on create or on update, not
removed on delete, a sort's min and max swapped, a child's `where` ignored, every row given to the
first parent, two rows of one key accepted, a kept row not updated, a row gone not deleted, the
order of a child ignored, the hand-written addresses not deleted, the parent's id not read. Passing
`:not` on to the child's parameter changes nothing (the kinds leave `:not` to the store), so it is
not a control.

### Not in this step

A child over sqb entities (`@Link`), a composite whose parts are on one child row, chains and
`_has` through a child's reference, and children of children. _A child over sqb entities came
next: see "A child over sqb entities"; the composite, chains and `_has` after it: see "Searches
through children"._

## A child over sqb entities (2026-11-23)

The third way to fill an `SqlChild`, for an application that already describes its tables as sqb
entities: `linked(ParentEntity, 'field', { sort, key, rows })` over a `@Link().toMany(...)` field.

### Built

- **`linked()`** (`packages/sql/src/linked.ts`) resolves the link from sqb's metadata once, in
  the child's `prepare()`, which the store calls before its first read, search or write: the
  child's entity, its table, the property and column of the foreign key, and its primary key. The
  link must be one `toMany` hop without conditions of its own; anything else is a TypeError.
- **Reads** are one `findMany` a page (`In(foreignKey, ids)`), sorted by the entity's properties;
  the rows given to `resource()` are the entity's objects, with its own property names and types.
- **Writes** go through the entity's `Repository`, matched by `key` (properties): a kept row
  `updateOnly` by its primary key (it keeps its id and the properties the resource does not map),
  a new one `createOnly`, one gone `delete`. Without a key, `deleteMany` and `createOnly`. Two
  rows of one key are refused (422).
- **Searches** join the entity's table on the foreign key's column; a parameter over the child
  names its columns, not its properties.
- **The store** gives a child `SqlRunner.repository(entity)`, a Repository on the same connection,
  so the child's writes are in the write's transaction; `SqlChild.prepare()` is new.
- **`examples/facade`** keeps diagnoses through sqb entities (`entities.ts`): the three ways are
  mixed, telecoms with `childTable()`, addresses with SQL of its own, diagnoses with `linked()`.
- **sqb 6.3.8**: `@Link().toMany(...)` threw without `emitDecoratorMetadata`, which this repository
  keeps off; reported to sqb's maintainers and fixed in 6.3.8 (panates/sqb#130). The peer
  dependency of `@fhirjs/sql` is `^6.3.8`.

### Tests and control runs

`packages/sql/test/sql-linked.spec.ts`: properties named apart from their columns, a child written
by a key (a kept row's id and a property FHIR does not see kept) and one without, searches and a
page over two parents, a write that fails after the child's rows were written (rolled back), and
three links refused. The facade's tests run with diagnoses through `linked()` unchanged.

Control runs, each caught: the sort ignored, key matching off, a kept row not updated, a row gone
not deleted, two rows of one key accepted, `remove()` doing nothing, the join on the property name
instead of the column, rows grouped by their own id instead of the parent's, a `toOne` link
accepted, the Repository on the pool instead of the write's connection, the children not prepared.

### Not in this step

A link with conditions of its own (`where`) or more than one hop, and parameters named by the
entity's properties. _A link with conditions came later: see "Searches through children"._

## Searches through children (2026-11-23)

- **A composite on one row**: when the parts of a composite (`component-code-value-quantity`)
  are parameters of a child (`child('components', ...)`), a value matches when one row of the
  child matches every part: one EXISTS a child, each part's `where` on that row. Before, each
  part was an EXISTS of its own, and an observation of 80/120 matched `8480-6$120` (the code on
  one row, the value on another). Parts of the parent stay on its row; parts of two children
  are an EXISTS each. `:missing` is the same: a row that has every part.
- **Chains through a child's reference**: a `child(name, reference(fk, Target), where)`
  parameter is followed by a chain (`Patient?general-practitioner.name=Smith`): EXISTS a row of
  the child, within its `where`, whose `fk` is the id of a target that matches. Chains go on
  from there (`Observation?subject.general-practitioner.name=...`).
- **`_has` through a child's reference**: `Practitioner?_has:Patient:general-practitioner:...`
  is EXISTS a patient one of whose child rows, within the `where`, refers to the practitioner.

Tests (`packages/sql/test/sql-child-search.spec.ts`, 3, PostgreSQL): blood pressures in a
components table (the same values on other rows, a row the `where` leaves out, a code and a
value on two rows); a care team whose GPs are the rows of role `gp`, chained by one and two
levels, and `_has` of one and two levels. Control runs, each caught (7): the parts on any rows,
the parts' `where` dropped, `:missing` on any rows, no chain through a child, the child's
`where` ignored, the foreign key read on the parent's row, no `_has` through a child.

- **A link with conditions of its own**: `linked()` takes a `toMany` hop with `where`
  (`Eq('kind', 'phone')`, or `{ kind: 'email' }`), so two links can share a table. Reads,
  writes and deletes go through the Repository with the conditions ANDed to the foreign key, so
  each link keeps to its own rows; a search joins the rows with the conditions as SQL of the
  child's columns, which sqb writes (`prepareEntityFilter`, `@sqb/connect` 6.4.0, asked of
  sqb for this) on an alias of its own that the search replaces. The rows a resource gives
  meet the conditions themselves (`kind: 'phone'`): one that does not is not read back, and the
  store refuses the resource. `@fhirjs/sql` needs sqb 6.4.0 or later.

Tests (`packages/sql/test/sql-linked.spec.ts`, 1 more, PostgreSQL): phones and emails, two links
over one contacts table (one condition an operator, one a plain object, a property named apart
from its column): written, changed (the other link's row kept, with its id), searched (a
parameter without a `where` of its own finds its link's rows only), refused, deleted. Control
runs, each caught (5): reads, writes and deletes, or searches without the conditions; the
alias not replaced; conditions refused.

### Not in this step

A link of more than one hop; parameters named by the entity's properties; children of
children.
