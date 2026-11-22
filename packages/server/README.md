# @fhirjs/server

FHIR REST server: a fetch-style handler over a store of your own.

It answers the REST API of one FHIR version, checking every resource it is sent against the
model of [`@fhirjs/core`](https://www.npmjs.com/package/@fhirjs/core). The resources are kept in a
store: the in-memory one, or a store of your own, which may be a facade over an existing
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
without storing it. `POST [base]` takes a batch Bundle, each entry run as a request of its own, and a transaction
Bundle, all or nothing, when the store has `transaction()` (the memory store has): new resources referred to by `urn:uuid:` and conditional references are resolved.

Search (`GET [type]?...`, `POST [type]/_search`) takes the token, string, date, reference,
number, quantity, uri and composite parameters of the version, with their modifiers and prefixes, sorts
with `_sort` and pages its results. `_include` and `_revinclude` (with `:iterate`) add the
resources the matches refer to and those that refer to them; chained parameters
(`subject:Patient.name`) and `_has` go to a store that declares `chains`. A store gets the criteria parsed and typed, to translate to
its own query language; the memory store matches them by the parameters' FHIRPath expressions.

### A store of your own

The server takes one store. A store of your own may serve every type, or some types next to a
FHIR store through `RoutingStore`: chains and `_has` then go only to types of the same store, and
a transaction runs in the default store, reading the others without writing them.

```ts
import { type FhirStore, MemoryStore, RoutingStore } from '@fhirjs/server';

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
  store: new RoutingStore({
    store: new MemoryStore(),
    routes: { Patient: patients },
  }),
});
```

### Authentication and authorization

Who may call is decided by authenticators, asked in turn (a JWT, or an API key); what they may do
by an authorizer. Both are interfaces: write your own, or wrap one (`checked()`) to check more,
such as a session kept in Redis.

```ts
import { checked, FhirServerError, JwtAuthenticator, SmartAuthorizer } from '@fhirjs/server';

const jwt = new JwtAuthenticator({ issuer: 'https://auth.example.org/realms/hbys' });
const users = checked(jwt, async principal => {
  if (!(await redis.exists(`session:${principal.claims.sid}`)))
    throw new FhirServerError(401, 'The session has ended', 'login');
});

new FhirServer({
  fhir,
  store,
  security: { authenticators: [users], authorizer: new SmartAuthorizer({ fhir }) },
});
```

Without a token the answer is 401; a token refused answers 401 with `invalid_token`. The
authorizer may refuse an interaction (403), restrict a search with criteria, and decide on each
resource read or written (404 for one the caller may not see). Stores get the caller as the last
argument of each method.

`SmartAuthorizer` reads SMART scopes, v1 and v2: `system/` scopes grant what they name,
`patient/` scopes keep to the patient's compartment, and `user/` scopes ask rules of your own
(`new SmartAuthorizer({ fhir, user: myRules })`). A v2 scope's query (`?category=laboratory`)
restricts it further.

## Documentation

[The design of the server](https://github.com/panates/fhir/blob/main/docs/decisions/server.md)

## License

BSD-3-Clause
