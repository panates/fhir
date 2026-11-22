# @fhirjs/server

FHIR REST server: a fetch-style handler over stores of your own.

It answers the REST API of one FHIR version, checking every resource it is sent against the
model of [`@fhirjs/core`](https://www.npmjs.com/package/@fhirjs/core). Each resource type is kept
in a store: the in-memory one, or a store of your own, which may be a facade over an existing
database of another shape. A store declares what it supports; the server refuses the rest and
says so in its `CapabilityStatement`.

## Install

```bash
npm install @fhirjs/server @fhirjs/core @fhirjs/r4
```

## Usage

```ts
import http from 'node:http';
import { FhirContext } from '@fhirjs/core';
import { r4Model } from '@fhirjs/r4';
import { FhirServer, MemoryStore, nodeListener } from '@fhirjs/server';

const server = new FhirServer({
  fhir: new FhirContext(r4Model),
  store: new MemoryStore(),
  base: '/fhir',
});

http.createServer(nodeListener(server)).listen(8080);
// or, wherever Request and Response are spoken:
const response = await server.handle(
  new Request('http://localhost/fhir/metadata'),
);
```

It answers `metadata`, `read`, `vread`, `create`, `update` (and update as create), `delete`
and `history` of an instance, a type and the server, with `ETag`, `If-Match`, `Location` and
`Prefer: return=`. A resource that is not valid is refused with 422 and its issues. Create, update,
delete and patch also come conditional (`If-None-Exist`, `PUT [type]?criteria`), `PATCH` takes a
JSON Patch, and `POST [type]/$validate` checks a resource against the model and a profile
without storing it.

Search (`GET [type]?...`, `POST [type]/_search`) takes the token, string, date, reference,
number, quantity and uri parameters of the version, with their modifiers and prefixes, sorts
with `_sort` and pages its results. A store gets the criteria parsed and typed, to translate to
its own query language; the memory store matches them by the parameters' FHIRPath expressions.

### A store of your own

```ts
import type { FhirStore } from '@fhirjs/server';

const patients: FhirStore = {
  // read only, and the table keeps no versions
  capabilities: type =>
    type === 'Patient'
      ? { interactions: ['read'], versions: 'none' }
      : undefined,
  async read(type, id) {
    const row = await db.findPatient(id);
    return (
      row && {
        type,
        id,
        resource: {
          resourceType: 'Patient',
          id,
          name: [{ family: row.surname }],
        },
      }
    );
  },
};

new FhirServer({
  fhir,
  store: new MemoryStore(),
  stores: { Patient: patients },
});
```

## Documentation

[The design of the server](https://github.com/panates/fhir/blob/main/docs/decisions/server.md)

## License

BSD-3-Clause
