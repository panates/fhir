# `@fhirjs/server`

The design of the FHIR server package, before any code. The decisions in the two "Decided"
sections were taken with the user (2026-11-21 and 2026-11-22); the rest is the proposal they lead
to, open to change until it is built.

## Decided (2026-11-21)

| Question | Decision | Why |
| -------- | -------- | --- |
| HTTP layer | A framework-free handler, `(request: Request) => Promise<Response>`, with thin adapters (`node:http`, Express; NestJS later) | FHIR's REST interface is fixed by the specification: its URLs, search parameters, `Bundle` and `OperationOutcome`. opra has REST rules of its own, which FHIR's would have to be bent into. The client already works on fetch's `Request` and `Response`, so both share one model, and interceptors have the same shape on both sides. |
| Storage | A store interface, and an in-memory store in the package. The server parses search parameters; the store answers them. Stores for Postgres and MongoDB come later, as packages of their own | The in-memory store makes the server usable and testable on day one. A database store can translate a parsed query to its own language, which a FHIRPath-only design would not allow. |
| First version | The core of the REST API: `capabilities`, `read`, `vread`, `create`, `update`, `delete`, `history`, search with the common parameter types and paging, conditional create, update and delete, JSON Patch, validation on write, `$validate` | These are what a client of a FHIR server expects. Batch and transaction need atomic stores, and `_include` and chained search need a store interface that has proven itself first. |
| Authorization | Second step. The first version leaves an interceptor point | Token checks (JWKS) and SMART v2 scopes (`patient/Observation.rs`) come in one piece later, with tests from the client's SMART work. |

## Decided (2026-11-22): data that is not stored as FHIR

The data does not have to be kept as FHIR resources. A hospital information system's existing
database is served through a store of its own that maps FHIR to its tables (a facade): a read
becomes a `SELECT` whose row is mapped to the generated class, a parsed search becomes a `WHERE`.
Three changes to the store design follow, taken with the user:

| Question | Decision | Why |
| -------- | -------- | --- |
| One store or many | A store per resource type, with a default store for the rest | `Patient` and `Encounter` can come from the existing database while `Questionnaire`, which it has no table for, is kept in a FHIR store. HAPI's "plain server" works the same way. |
| What a store supports | A store declares, per type, the interactions it has and the search parameters it answers. The server refuses the rest, and the `CapabilityStatement` says so | An existing database rarely keeps versions, and not every search parameter has a column. A facade that cannot answer `name:contains` must say so rather than answer wrongly. |
| Versions | Three levels: every version kept, the current version only, none | A table with an update time or a row version can give `versionId` and check `If-Match`, without `vread` of old versions or `history`. A table with neither has no versions at all. |

Copying the data into a FHIR store instead (ETL or change data capture) stays possible and needs
nothing of the server: the copy is a FHIR store like any other. The two are often combined, a
facade for what must be current and a copy for searching and reporting; a store per type is
what makes that one server.

## Shape

```ts
import { FhirContext } from '@fhirjs/core';
import { r4Model } from '@fhirjs/r4';
import { FhirServer, MemoryStore, nodeListener } from '@fhirjs/server';
import http from 'node:http';

const server = new FhirServer({
  fhir: new FhirContext(r4Model),
  store: new MemoryStore(),              // the default store
  stores: {                              // stores of their own for some types
    Patient: hbysPatients,               // a facade over the existing database
    Encounter: hbysEncounters,
  },
  resources: ['Patient', 'Encounter', 'Questionnaire'], // the types it serves; all when not given
  base: '/fhir',                         // the path it answers under
  interceptors: [],                      // (request, next) => Promise<Response>, as in the client
});

http.createServer(nodeListener(server)).listen(8080);
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
  /** What the store does for a type, asked once when the server starts; undefined: not this type */
  capabilities(type: string): StoreCapabilities | undefined;
  read?(type: string, id: string): Promise<StoredResource | undefined>;
  vread?(type: string, id: string, versionId: string): Promise<StoredResource | undefined>;
  create?(type: string, resource: object): Promise<StoredResource>;
  update?(type: string, id: string, resource: object, ifMatch?: string): Promise<StoredResource>;
  delete?(type: string, id: string, ifMatch?: string): Promise<StoredResource | undefined>;
  history?(type: string | undefined, id: string | undefined, query: HistoryQuery): Promise<Page>;
  search?(type: string, query: SearchQuery): Promise<Page>;
}

interface StoreCapabilities {
  interactions: ('read' | 'vread' | 'create' | 'update' | 'delete' | 'history' | 'search')[];
  /** 'all': every version kept; 'current': the current one's versionId; 'none' */
  versions: 'all' | 'current' | 'none';
  /** The search parameters it answers, by code; all of the type's when not given */
  searchParams?: string[];
  /** The parameters it can sort by */
  sort?: string[];
}
```

- **The server asks a type's store, or the default store.** An interaction the store does not
  declare answers 405. A search parameter it does not answer is treated as unknown: 400 with
  `Prefer: handling=strict`, left out of the `self` link otherwise, so the client sees which
  criteria were applied.
- **The store gives ids** (an existing database's composite key is encoded into one, within
  FHIR's `[A-Za-z0-9-.]{1,64}`), and `meta.lastUpdated` when it knows it.
- **Versions.** With `'all'`, the store keeps every version, for `vread` and `history`, and a
  deleted resource is a version with no body (`read` answers 410). With `'current'`, it gives the
  current `versionId` (a row version, an update time) and checks `ifMatch`, but has no older
  versions. With `'none'`, there is no `versionId`, no `ETag`, and a request with `If-Match` is
  refused (412). The `CapabilityStatement` gives `versioning` (`versioned-update` or
  `no-version`) and `readHistory` from it.
- `ifMatch` is the version the client read (`If-Match: W/"3"`); a store refuses a stale one, and
  the server answers 412.
- **A facade's writes** map a validated resource to its tables. A store that cannot keep some
  element (no column for it) refuses the write rather than drop the element silently.
- **Codes.** An existing database's local codes are mapped to standard ones (LOINC, SNOMED CT,
  ICD-10) by the facade, by hand or through a `ConceptMap`; the server does not translate codes.
- `MemoryStore` declares everything, with `versions: 'all'`. A helper for SQL facades (on sqb)
  may follow once a first real facade is written; it is not designed before that.
- `SearchQuery` is parsed and typed, not the URL: each parameter with its definition, modifier,
  prefix and values, plus `_sort`, `_count` and the page. `MemoryStore` evaluates it with the
  FHIRPath expression of each parameter; a database store translates it.
- Conditional interactions run as a search first (`If-None-Exist`, `PUT [type]?criteria`); the
  server decides from the number of matches, as the specification says. They need the store to
  answer the search parameters of the criteria.

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
- **Where the definitions come from:** see "Search parameter tables" below (decided and built).

## Search parameter tables (2026-11-21)

Decided with the user: the generator writes the search parameters of each version into its
package, so a server needs no HL7 package at run time. Built:

- `FhirSearchParameter` in `@fhirjs/core` (`search-parameter.ts`): `url`, `code`, `type`, `base`,
  `expression`, `target`, `component`. `FhirModel` keeps them by base type:
  `model.searchParameters('Patient')` gives the type's own and those of its base types
  (`Resource`'s `_id`), by code; `model.getSearchParameter('Patient', 'birthdate')` one of them.
  A profile class has its type's. `FhirContext` copies them into its own model.
- `support/build-models.mts` writes `search-parameters.ts` (`R4_SEARCH_PARAMETERS` ...) and gives
  it to the version's model. It leaves out the core package's examples
  (`SearchParameter/example`, `example-reference`), which would replace `_id` and
  `Condition.subject`, and the ten R4 and R4B extension parameters with no `base`. Where two
  define one code on one base (R4B's and R5's `filter` and `Resource-filter`), the one named after
  its base is kept.
- `loadPackage()` adds an implementation guide's `SearchParameter` resources (US Core: 106); one
  with the code of a core parameter replaces it on that base (US Core's `_id` of Patient). A FHIR
  core package adds none: the model has its parameters already, and its examples would replace
  real ones. A parameter on a type the model does not have is reported and left out (the R4
  extensions package has one on R5's `DeviceUsage`). `FhirPackage` now indexes
  `SearchParameter` resources.

| Version | Parameters | Without an expression |
| ------- | ---------- | --------------------- |
| R4 | 1,387 | 6: `_text`, `_content`, `_filter`, `_query`, and `Patient.age`, `Patient.birthOrderBoolean` |
| R4B | 1,425 | 10: the special ones (`_has`, `_list`, `_type` ...) and the same two of Patient |
| R5 | 1,239 | 12: the special ones, and `ImagingStudy.reason`, `Medication.form` and two of `MedicationKnowledge`, which the specification left without one |

Every expression parses, and every base and target is a type of the model. The tables add about
600 KB of source to each version package; the `@FhirElement` counts are unchanged.

Tests: `packages/{r4,r4b,r5}/test/search-parameters.spec.ts` (shared checks in
`packages/core/test/_support/search-parameters.ts`), with control runs: without skipping the core
package, it adds 1,390 parameters; without indexing `SearchParameter`, US Core adds none.

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
version, the resource types, and for each what its store declares: interactions, search
parameters, versioning; then the operations. Nothing in it is written by hand.

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

## Built: the package, the stores, read and write (2026-11-22)

`packages/server`: `FhirServer`, `FhirStore` with `StoreCapabilities`, `MemoryStore`,
`nodeListener()`, `FhirServerError`. It answers `metadata`, `read`, `vread`, `create`, `update`
(and update as create), `delete`, and `history` of an instance, a type and the server. Search,
conditional interactions, JSON Patch and `$validate` are the next steps.

Where it differs from the proposal above, and why:

- **`base` is an option of the server**, not of `nodeListener()`: the server writes its base URL
  into `Location`, `fullUrl` and links, wherever it runs. `nodeListener(server)` takes nothing
  else; under Express it reads `originalUrl`, so the mount path is kept.
- **Stores keep JSON.** A store gets the resource in its JSON form, after the server has checked
  it, and gives back JSON (or a plain object a facade builds). The server reads what a store gives
  through the model before it answers: a facade's mapping error is a 500 that names the resource,
  not a wrong answer. Decimals keep their places through `MemoryStore`, which keeps JSON text
  (`1.50` stays `1.50`).
- **`create` ignores the id of the body**, and `update` refuses a body without an id or with
  another one (400), as the specification says.
- **History pages** carry their place as `_offset` in the `next` and `previous` links, with
  `_count` (default 50, at most 500) and `_since`.
- **History of the server** is answered when every type is in one store; with stores per type it
  answers 405, and the `CapabilityStatement` leaves out `history-system`.
- **`delete`** answers 204, also for a resource that is not there or is already deleted.
- **An error the server did not expect** (a store's connection refused) answers 500 without its
  message, which goes to `onError`.

Tests: `packages/server/test/fhir-server.spec.ts`, 21, over `node:http` with `@fhirjs/client` and
plain `fetch`: every interaction above, the statuses of what is refused (400, 404, 405, 406, 410,
412, 415, 422), a facade over a table of another shape (`HbysPatients`: read and update, no
versions), interceptors. The `CapabilityStatement` and the history `Bundle` pass `validate()`.
Control runs: without the If-Match check, without validation on write, with an ETag for a store
without versions, and without the 405 check, a test fails each time. 219 tests before, 240 after.

## Not in the first version

Batch and transaction, `_include` and `_revinclude`, chained and reverse-chained search (`_has`),
composite parameters, `_summary` and `_elements` on search, SMART authorization, XML,
subscriptions, bulk data.
