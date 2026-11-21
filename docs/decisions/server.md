# `@fhirjs/server`

The design of the FHIR server package, before any code. The decisions in the first section were
taken with the user on 2026-11-21; the rest is the proposal they lead to, open to change until it
is built.

## Decided (2026-11-21)

| Question | Decision | Why |
| -------- | -------- | --- |
| HTTP layer | A framework-free handler, `(request: Request) => Promise<Response>`, with thin adapters (`node:http`, Express; NestJS later) | FHIR's REST interface is fixed by the specification: its URLs, search parameters, `Bundle` and `OperationOutcome`. opra has REST rules of its own, which FHIR's would have to be bent into. The client already works on fetch's `Request` and `Response`, so both share one model, and interceptors have the same shape on both sides. |
| Storage | A store interface, and an in-memory store in the package. The server parses search parameters; the store answers them. Stores for Postgres and MongoDB come later, as packages of their own | The in-memory store makes the server usable and testable on day one. A database store can translate a parsed query to its own language, which a FHIRPath-only design would not allow. |
| First version | The core of the REST API: `capabilities`, `read`, `vread`, `create`, `update`, `delete`, `history`, search with the common parameter types and paging, conditional create, update and delete, JSON Patch, validation on write, `$validate` | These are what a client of a FHIR server expects. Batch and transaction need atomic stores, and `_include` and chained search need a store interface that has proven itself first. |
| Authorization | Second step. The first version leaves an interceptor point | Token checks (JWKS) and SMART v2 scopes (`patient/Observation.rs`) come in one piece later, with tests from the client's SMART work. |

## Shape

```ts
import { FhirContext } from '@fhirjs/core';
import { r4Model } from '@fhirjs/r4';
import { FhirServer, MemoryStore, nodeListener } from '@fhirjs/server';
import http from 'node:http';

const server = new FhirServer({
  fhir: new FhirContext(r4Model),
  store: new MemoryStore(),
  resources: ['Patient', 'Observation'], // the types it serves; all when not given
  interceptors: [],                      // (request, next) => Promise<Response>, as in the client
});

http.createServer(nodeListener(server, { base: '/fhir' })).listen(8080);
// or: await server.handle(new Request('http://localhost/fhir/Patient/1'))
```

- One server serves one FHIR version: the `FhirContext` it is given, as for the client. Profiles
  and IG packages come through that context.
- `handle()` never throws for a bad request: the answer is an `OperationOutcome` with the status
  the specification gives (400, 404, 405, 409, 410, 412, 422).
- JSON only (`application/fhir+json`). An XML request gets 406 or 415, until core reads XML.

## Store

```ts
interface FhirStore {
  read(type: string, id: string): Promise<StoredResource | undefined>;
  vread(type: string, id: string, versionId: string): Promise<StoredResource | undefined>;
  create(type: string, resource: object): Promise<StoredResource>;
  update(type: string, id: string, resource: object, ifMatch?: string): Promise<StoredResource>;
  delete(type: string, id: string, ifMatch?: string): Promise<StoredResource | undefined>;
  history(type: string | undefined, id: string | undefined, query: HistoryQuery): Promise<Page>;
  search(type: string, query: SearchQuery): Promise<Page>;
}
```

- The store gives ids, `meta.versionId` and `meta.lastUpdated`, and keeps every version (for
  `vread` and `history`). A deleted resource is a version with no body: `read` answers 410.
- `ifMatch` is the version the client read (`If-Match: W/"3"`); a store refuses a stale one, and
  the server answers 412.
- `SearchQuery` is parsed and typed, not the URL: each parameter with its definition, modifier,
  prefix and values, plus `_sort`, `_count` and the page. `MemoryStore` evaluates it with the
  FHIRPath expression of each parameter; a database store translates it.
- Conditional interactions run as a search first (`If-None-Exist`, `PUT [type]?criteria`); the
  server decides from the number of matches, as the specification says.

## Search

- **Parameter types in the first version:** token, string, date, reference, number, quantity, uri;
  `_id` and `_lastUpdated`. Composite and special parameters come later.
- **Modifiers and prefixes:** `:missing`, `:exact`, `:contains`, `:not`, `:text` (token), a type
  on a reference (`subject:Patient`); prefixes `eq ne lt gt le ge sa eb ap` for date, number and
  quantity, with the implicit ranges of dates (`2020` is the whole year).
- **Paging:** `_count`, and the `next`, `previous` and `self` links of the searchset `Bundle`. The
  link carries the page as an offset, so the server keeps no state between requests.
- **An unknown parameter** is an error (400) when the request says `Prefer: handling=strict`, and
  is left out of `self` otherwise, as the specification says.
- **Where the definitions come from.** Core does not read `SearchParameter` resources today, and
  the generated packages do not hold them. Proposal: the generator writes a compact table per
  version (name, type, base types, FHIRPath expression, target types) into `@fhirjs/r4`, `r4b`
  and `r5`, and an IG package adds its own `SearchParameter` resources through `FhirPackage`.
  R4's core package has about 1,400 of them.

## Writing

- **Validation:** `create`, `update` and `patch` run `FhirContext.validate()` (profiles of
  `meta.profile` included). An error answers 422 with the issues as an `OperationOutcome`;
  warnings do not stop the write. `$validate` runs the same check and stores nothing.
- **The body against the URL:** `update` refuses a body whose `id` or `resourceType` differs
  from the URL (400). `create` ignores an `id` in the body.
- **`Prefer: return=`** `minimal`, `representation` (the default) or `OperationOutcome`.
  Answers carry `ETag`, `Last-Modified` and, on create, `Location`.
- **JSON Patch** (`application/json-patch+json`) is applied to the current version, then
  validated like an update.

## Capabilities

`GET [base]/metadata` gives a `CapabilityStatement` built from what the server serves: its FHIR
version, the resource types, their interactions and search parameters, the operations. Nothing in
it is written by hand.

## Extending

- **Interceptors** around every exchange, the first given outermost, as in the client:
  `(request, next) => Promise<Response>`. Authorization and logging go here.
- **Operations:** `server.operation('$name', { resource, instance, handler })` registers a custom
  operation at system, type or instance level.

## Tests

- The server is tested through `@fhirjs/client` over real HTTP: every interaction the client has
  is run against it. The in-memory server in the client's tests (`test/_support/test-server.ts`)
  can then be replaced by this one.
- Search is tested against the R4 examples (`hl7.fhir.r4.examples`): each parameter type,
  modifier and prefix, with the expected matches.

## Not in the first version

Batch and transaction, `_include` and `_revinclude`, chained and reverse-chained search (`_has`),
composite parameters, `_summary` and `_elements` on search, SMART authorization, XML,
subscriptions, bulk data.
