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

## Built: search, first part (2026-11-22)

`GET [type]?...` and `POST [type]/_search` (a form). Code: `search-query.ts` (the parsed query
and its parsing), `search-match.ts` (`SearchMatcher`, by FHIRPath), `_search()` in
`fhir-server.ts`, `MemoryStore.search()`.

- **Types:** token, string, date and reference, with `_id` and `_lastUpdated`. A parameter of
  another type (number, quantity, uri, composite, special) is treated as unknown for now; the
  second part below adds number, quantity and uri.
- **Modifiers:** string `:exact`, `:contains`, `:missing`; token `:not`, `:text`, `:missing`; date
  and reference `:missing`; a resource type on a reference (`subject:Patient`). Any other
  modifier is refused (400), as the specification asks.
- **Values:** commas give OR (`\,` escapes one), a parameter given twice gives AND. Tokens as
  `code`, `system|code`, `system|`, `|code`; on a CodeableConcept, a Coding, an Identifier, a
  ContactPoint's value, or a code. Dates as ranges (`1980` is the year, `2020-03-04T10:00Z` the
  minute; a time without a zone is UTC), with `eq ne lt gt le ge sa eb ap`, on dates, dateTimes,
  instants, Periods and a Timing's events. `eq` means the target's range is within the
  value's. References as `Type/id`, `id`, or an absolute URL; one under the server's base is a
  local one.
- **Strings** match by their start, without case or accents; `ı` is read as `i`, so `yilmaz`
  finds `Yılmaz` and `istanbul` finds `İstanbul`. A HumanName is searched by its text, family,
  given, prefix and suffix; an Address by its text, lines, city, district, state, postal code and
  country.
- **A store gets the criteria parsed and typed** (`SearchQuery`): each with its parameter's
  definition, modifier and values (system and code, date range, reference type and id), and
  `count` and `offset`. A store with a query language translates them; `query.matches()` checks
  one resource by the parameters' FHIRPath expressions, which is how `MemoryStore` searches.
  `resolve()` in an expression (`subject.where(resolve() is Patient)`) reads the type from the
  reference's text.
- **The parameters a type answers** are the store's `searchParams`, or every parameter with an
  expression when it names none, of the types above. A name the type does not have is refused
  when the server starts. The `CapabilityStatement` lists them.
- **Unknown parameters** are left out, and out of the `self` link; with
  `Prefer: handling=strict` they are refused (400).
- **Paging** as for history: `_count` (default 50, at most 500), `_offset` in `next` and
  `previous`. Results come in the store's order; `_sort` came in the second part.

Tests: `packages/server/test/search.spec.ts`, 12: each type with its modifiers and prefixes on
three Patients and three Observations (Turkish names among them), paging, POST, unknown
parameters, refused values, the `CapabilityStatement`, a store that answers one parameter and
gets the parsed criteria, `dateRange()`. Control runs: without reading `ı` as `i`, with `eq` as
overlap, without `resolve()`, with `|code` ignoring the system, and without `handling=strict`, a
test fails each time. 240 tests before, 252 after.

## Built: search, second part (2026-11-22)

Number, quantity and uri parameters, and `_sort`.

- **Numbers:** `eq` and `ne` by the value's precision, as the specification says: `100` covers
  [99.5, 100.5), `0.3` covers [0.25, 0.35), `0.30` covers [0.295, 0.305), `1e2` covers [50, 150).
  `gt`, `lt`, `ge`, `le` compare with the number itself; `sa` and `eb` as `gt` and `lt`; `ap`
  within 10% of it.
- **Quantities:** `[prefix]number|system|code`, `number||code` or `number`, on a Quantity (and
  Age, Count, Distance, Duration, SimpleQuantity) or a Money. The number as for numbers; a system
  given must be the quantity's, with its code; a code alone may be the code or the unit. **Units
  are not converted**: `5|http://unitsofmeasure.org|mg` does not find 0.005 g. The FHIRPath
  package has a UCUM subset that could do it; that is left for when a store needs it.
- **URIs:** as they are; `:below` finds the URIs under the value by path
  (`url:below=http://example.org/fhir`), `:above` those the value is under. A canonical's
  `|version` is not split off.
- **`_sort`:** `_sort=-date,name`, by parameters of any type above. Each resource sorts by its
  first value of the parameter: the lowest ascending, the highest descending (a date by the start
  of its range ascending and the end descending, so `1980` comes before `1980-02-03` ascending
  and after it descending); a resource without the value comes last either way. A store names
  what it can sort by in `sort`; the others, and unknown names, are left out of the query and
  the links, or refused with `handling=strict`. `query.sort` gives the store the order, and
  `query.compare()` compares two resources by FHIRPath, as `MemoryStore` sorts.
- **Composite and special parameters** stay unsearched.

Tests: 5 more in `packages/server/test/search.spec.ts`, on two RiskAssessments, two Observations
with quantities and three ValueSets: each prefix of a number, quantities with and without units,
`:below` and `:above`, `_sort` ascending, descending, by two parameters, with missing values,
and a store that names what it sorts by. Control runs: `eq` of a number without its precision,
a quantity's unit ignored, `:below` as equality, the memory store not sorting, and descending
ignored, a test fails each time. 252 tests before, 257 after.

## Built: conditional interactions, JSON Patch, $validate (2026-11-22)

With these the first version of the design is complete.

- **Conditional create** (`If-None-Exist`): created when the criteria find nothing; the resource
  found is given back with 200 when they find one (nothing is written); 412 when they find more.
- **Conditional update** (`PUT [type]?criteria`): updates the one resource found (a body id must
  be its id, 400 otherwise); creates when nothing is found, with the body's id when it has one
  (an update as create) or one the store gives; 412 for more than one.
- **Conditional delete** (`DELETE [type]?criteria`): deletes the one resource found; 204 when
  nothing is found; 412 for more than one (`conditionalDelete: single`).
- **Their criteria are read strictly**: an unknown parameter is refused (400), since leaving it
  out would widen the criteria, and empty criteria are refused. They need a store that searches;
  without one they answer 405, and the `CapabilityStatement` says `false` and `not-supported`.
- **`PATCH`** with a JSON Patch (`application/json-patch+json`, RFC 6902: add, remove, replace,
  move, copy, test), on `[type]/[id]` or `[type]?criteria` (the one resource found; 404 for none,
  412 for more). It is applied to the current version, then checked like an update (422 with the
  model's issues) and written by `update`, so `If-Match` and versions work as for `PUT`. A patch
  that is not one answers 400; one that cannot be applied (a path that is not there, a failed
  test) 422; one that changes the id or the type 422. Decimals keep their places, those the patch
  leaves and those it writes (`2.50`). The `CapabilityStatement` lists `patch` for a type whose
  store reads and updates.
- **`POST [type]/$validate`** with the resource, or a Parameters with `resource` and `profile`;
  `profile` may also be in the URL. It answers 200 with the issues as an OperationOutcome
  (warnings included, such as `dom-6`), and stores nothing. A profile the server does not know is
  refused (400). Each type lists the operation in the `CapabilityStatement`.

Tests: `packages/server/test/conditional.spec.ts`, 14, over HTTP and through `@fhirjs/client`'s
conditional calls and `patch()`. Control runs: a conditional create that always creates, a patch
that drops the text of a decimal it writes, a `test` that always passes, a conditional update
that takes the first of several, and `$validate` without the profile asked for, a test fails each
time. 257 tests before, 271 after.

## Batch and transaction (2026-11-22)

`POST [base]` with a Bundle of type `batch` or `transaction`. The decisions were taken with the
user; the rest is the proposal they lead to, open to change until it is built.

| Question | Decision | Why |
| -------- | -------- | --- |
| Which first | Batch first, transaction after it | A batch needs nothing new of the stores: each entry is an interaction the server already has. |
| How a transaction is atomic | Through an optional store interface, `transaction()`: the store gives a view whose writes are kept when the work ends and undone when it fails | Only the store can make writes atomic (a database's `BEGIN` / `COMMIT` / `ROLLBACK`). The server cannot undo what a store has written. |
| Across stores | A transaction is answered only when every entry's type is in one store that has `transaction()`; otherwise it is refused (400), and the `CapabilityStatement` does not list it | With a type in an existing database and another in memory, nothing can make the two atomic together; a transaction that is atomic in part would be worse than none. |

### Batch

- **Each entry is a request of its own**, as if it had come alone: `request.method` and
  `request.url` (relative to the base: `Patient/1`, `Patient?name=x`, `Patient/1/_history/2`),
  the resource, and `ifMatch`, `ifNoneExist`, `ifNoneMatch` as its headers. Every interaction
  of the server can be an entry: read, search, create, update, patch (a `Binary` with the JSON
  Patch, as the specification has it), delete, conditional ones, `$validate`.
- **The caller is authenticated once**, for the Bundle; each entry is authorized as its own
  interaction (a 403 for one entry does not stop the others). The interceptors run around the
  Bundle, not around each entry.
- **Entries run in the order given**, one after the other; one that fails does not stop the
  others.
- **The answer is a `batch-response` Bundle**, 200, with an entry per entry in the same order:
  `response.status` (`201 Created`), `location`, `etag`, `lastModified`, the resource as
  `Prefer: return=` asks for the Bundle, and `response.outcome` (an OperationOutcome) for an
  entry that failed.
- **A limit** on the entries of a Bundle (`maxBundleEntries`, default 100): more is refused with
  413, so that one request cannot hold the server.

### Transaction

- **The store interface:**

  ```ts
  interface FhirStore {
    // ...
    /**
     * Runs `work` with a view of the store whose writes are kept when it resolves, and undone
     * when it throws: what the work reads sees its own writes, and nothing else sees them first
     */
    transaction?<T>(work: (tx: FhirStore) => Promise<T>, context?: FhirRequestContext): Promise<T>;
  }
  ```

  `MemoryStore` does it with an undo log; a SQL store with `BEGIN`, `COMMIT` and `ROLLBACK`.
  The view has the same methods as the store.
- **All or nothing:** an entry that fails ends the transaction. The answer is that entry's
  status with its OperationOutcome (naming the entry), and nothing is written. Authorization
  counts too: one entry the caller may not do refuses the whole transaction (403).
- **The order of the specification**, whatever the order of the Bundle: deletes, then creates,
  then updates and patches, then reads and searches, which see the transaction's writes.
- **New resources and their references:** an entry to create has a placeholder `fullUrl`
  (`urn:uuid:...`), and other entries refer to it by that placeholder. The server gives each such
  resource its id before anything is written, and rewrites every reference to the placeholder
  (`Patient/<id>`), so that resources can refer to each other in a cycle. The store then needs to
  keep the id it is given: it declares `acceptsIds: true` in its capabilities (MemoryStore does);
  a store that gives ids itself cannot take part in a transaction with placeholders.
- **Conditional references** (`Patient?identifier=urn:oid:...|123` as a reference) are resolved
  by a search before the writes: one match is the reference, none or more than one fails the
  transaction (412).
- **Conditional entries** (`ifNoneExist`, `PUT [type]?criteria`, conditional delete) search inside
  the transaction.
- **The answer is a `transaction-response` Bundle**, 200, with an entry per entry in the order of
  the request.
- The `CapabilityStatement` lists `batch` always, and `transaction` when every type served is in
  one store with `transaction()`.

### Not in this step

A Bundle of type `history` or `message` as input (refused, 400), `_include` and chained search
(the next step), and transactions across stores.

## Not in the first version

Batch and transaction, `_include` and `_revinclude`, chained and reverse-chained search (`_has`),
composite parameters, `_summary` and `_elements` on search, SMART authorization, XML,
subscriptions, bulk data.
