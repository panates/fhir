# @fhirjs/sql

A FHIR store over an existing SQL database, described table by table: reads, searches and
writes of [`@fhirjs/server`](../server) translated to SQL with [sqb](https://github.com/panates/sqb).

The database keeps its own tables. Each resource type names its table, a function that maps a
row to a resource, and its search parameters by the kind of column behind them. The store
answers `read` and `search`, with chains, `_has`, composites, `_sort` and paging; the server
adds `_include`, `_revinclude`, `_summary` and `_elements`. A table that also maps a resource
back to its columns is written: `create`, `update`, `delete` and transaction Bundles.

## Install

```bash
npm install @fhirjs/sql @fhirjs/server @sqb/builder @sqb/connect @sqb/postgres
```

PostgreSQL only for now, with the `unaccent` extension in the `public` schema (strings are
compared without case and accents, as FHIR asks).

## Usage

```ts
import '@sqb/postgres';
import { SqbClient } from '@sqb/connect';
import { FhirServer } from '@fhirjs/server';
import {
  SqlStore,
  code,
  date,
  day,
  onlyElements,
  reference,
  string,
  token,
} from '@fhirjs/sql';

const store = new SqlStore({
  client: new SqbClient({
    dialect: 'postgres',
    host: 'localhost',
    database: 'emr',
  }),
  types: {
    Patient: {
      table: 'patients',
      lastUpdated: 'updated_at',
      select: a => `${a}.id::text as id, ${a}.last_name, ${a}.gender`,
      resource: row => ({
        resourceType: 'Patient',
        id: row.id,
        name: [{ family: row.last_name }],
        gender: { M: 'male', F: 'female' }[row.gender as string],
      }),
      params: {
        family: string('last_name'),
        gender: token(code('gender', { map: { M: 'male', F: 'female' } })),
        birthdate: date(day('birth_date')),
      },
      sort: ['family', 'birthdate'],
      // the mapping back, for writes; without it the type is read-only
      row: r => {
        onlyElements(r, ['name', 'gender', 'birthDate']);
        return {
          last_name: r.name?.[0]?.family ?? null,
          gender: { male: 'M', female: 'F' }[r.gender as string] ?? null,
          birth_date: r.birthDate ?? null,
        };
      },
    },
  },
});

const server = new FhirServer({ fhir, store, resources: ['Patient'] });
```

The kinds of a column: `code` and `constant` (for `token`), `string`, `instant`, `day` and
`period` (for `date`), `number`, `quantity`, `reference` (a foreign key; chains and `_has` follow
it) and `composite` (its parts on one row). A column is a name or an SQL expression of the row's
alias. A parameter the kinds do not cover is a function of its own: `(ctx, criterion) => Cond`.

## Writes

`row(resource, db)` gives every column it maps, null where the resource has no value, and
refuses (422) an element it has no column for: `onlyElements()`. The store writes the row in a
database transaction, sets the id and `lastUpdated` columns, and reads the row back: an element
of the resource that did not come back fails the write. A table that names `lastUpdated` as a
column has versions (ETag, If-Match); the versionId is the milliseconds of that column. The
database's refusals are answered as FHIR does: a unique key or a row still referred to 409, a
value the table refuses 422.

[`examples/facade`](../../examples/facade) describes an EMR's tables this way, and the design is
in [`docs/decisions/sql-facade.md`](../../docs/decisions/sql-facade.md).
