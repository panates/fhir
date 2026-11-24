# Handover note (2026-11-21)

Where the FHIR library stands, for whoever picks it up next. The design and every measured
result are in [`design/decorator-model.md`](design/decorator-model.md) (sections 11–13, one
dated part per piece of work). This note summarizes it and adds what that document does not
say: how to work in the repository, what is open, and what to watch for.

## State

- Pull requests [panates/fhir#1](https://github.com/panates/fhir/pull/1) (`feat/fhir-library`)
  and [panates/fhir#2](https://github.com/panates/fhir/pull/2) (CI and the repository
  standards) are merged into `dev`. `dev` did not exist before this work and was made from
  `main`.
- 359 tests pass (`pnpm test`), 396 with `FHIR_PG_URL`; type checks are clean (`pnpm build`, `tsc -p tsconfig-test.json`).
- CI: `.github/workflows/test.yml` runs on pull requests into `dev` and on pushes to `dev`. It
  builds, checks the types of the tests, fetches the HL7 packages (cached, keyed by the hash of
  `support/fetch-packages.mts`; a pull request restores the cache `dev`'s runs save), checks that
  `pnpm generate` leaves the committed sources unchanged, and runs the tests with coverage. The
  ten tests tagged `#slow` run in a second job in parallel, without coverage.
- Nothing is published yet; every package is at `0.0.0`. The release setup is built: rman, one
  version for all packages, betas of 1.0.0 under the npm dist-tag `beta`, `release.yml` on a merge
  into `main` ([`decisions/release.md`](decisions/release.md)). The npm scope `@fhirjs` belongs to
  the user.

## Packages

| Package                                   | Folder                                       | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@fhirjs/core`                            | `packages/core`                              | Decorators and the runtime model (`FhirModel`, `FhirTypeInfo`), the codec on valgen (`FhirContext`: `decode`, `encode`, `stringify`, `validate`), profiles and extensions, IG package loading (`FhirPackage`, `FhirPackageCache`, `ProfileBuilder`), invariants through FHIRPath                                                                                                                                                                                                                                                                                        |
| `@fhirjs/fhirpath`                        | `packages/fhirpath`                          | Our own FHIRPath engine: hand-written lexer and Pratt parser, evaluator, functions, a UCUM subset, and `check()` (static type checking). No dependency; the FHIR model comes through the `FhirPathModel` interface                                                                                                                                                                                                                                                                                                                                                      |
| `@fhirjs/r4`, `@fhirjs/r4b`, `@fhirjs/r5` | `packages/r4`, `packages/r4b`, `packages/r5` | Generated classes of FHIR 4.0.1, 4.3.0 and 5.0.0, with the codes of their required value sets and `r4Model` / `r4bModel` / `r5Model`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `@fhirjs/client`                          | `packages/client`                            | REST client (`FhirClient`), search paging, conditional interactions, `bearerToken()`, SMART on FHIR (discovery, backend services, app launch with PKCE, id_token verification)                                                                                                                                                                                                                                                                                                                                                                                          |
| `@fhirjs/smart`                           | `packages/smart`                             | JWT verification with JWK Sets (keys kept, read again on rotation, at most every 30 s), and SMART scopes v1 and v2. The client verifies id_tokens with it; the server will verify access tokens                                                                                                                                                                                                                                                                                                                                                                         |
| `@fhirjs/server`                          | `packages/server`                            | Read, write, history and search (every parameter type but special, `_sort`), conditional interactions, JSON Patch and `$validate` built: the first version of the design is complete. Authentication and authorization next, designed in [`decisions/server-auth.md`](decisions/server-auth.md). Designed in [`decisions/server.md`](decisions/server.md): a fetch-style handler, one store (an in-memory one, or a facade over an existing database that declares what it supports; `RoutingStore` sends types to stores of their own), the core of the REST API first |
| `@fhirjs/sql`                             | `packages/sql`                               | A store over an existing SQL database, described table by table: reads, searches and writes translated to SQL with sqb, transactions in one database transaction. PostgreSQL. Designed and built in [`decisions/sql-facade.md`](decisions/sql-facade.md)                                                                                                                                                                                                                                                                                                                |

## Working in the repository

Node 22 or later, pnpm 12.

```bash
pnpm install
pnpm fetch-packages   # HL7 packages, US Core and its dependencies, the FHIRPath suites, into support/fhir-packages/ (not committed, about 1.3 GB)
pnpm build
pnpm test
```

- **Tests that need the HL7 packages are skipped** when `pnpm fetch-packages` has not been
  run. Run it, or the numbers above are not what you are measuring.
- **The generated sources are committed** (`packages/{r4,r4b,r5}/src`, marked
  `linguist-generated`). After a change to `support/build-models.mts`, run `pnpm generate` and
  commit what it writes. A generator change for one version must leave the others unchanged.
  Check it with the count of `@FhirElement` in each version (R4 5,534, R4B 5,652, R5 7,097) and of search parameters (R4 1,387, R4B 1,425, R5 1,239).
- **`pnpm build` is `rman build`**: eslint, `rman check` (the manifests, circular imports), a
  clean, then `tsc -b` per package. Delete the `*.tsbuildinfo` files with `build/` when you run
  `tsc -b` yourself: with the build info left behind it emits nothing.
- **`experimentalDecorators: true` must stay on** (legacy decorators, as opra uses them).
- **`emitDecoratorMetadata` is off** for the generated packages and the tests. With it on, a
  class that refers to one declared later in the same file fails with a TDZ ReferenceError
  (`TimingRepeat`).
- **valgen is Panates' own package.** A problem found in valgen goes to the valgen session or
  its maintainers; it is not patched from here (the user's rule). The codec needs valgen 7.0.13
  or later.
- The FHIRPath suites are read at a fixed commit of `FHIR/fhir-test-cases`
  (`2cfcc672d39fe85dcf358106969cf63e185fd926`), set in `support/fetch-packages.mts`.
- Repository content is in English; when a pull request names `@fhirjs/...`, it goes in
  backticks (a bare `@name` tags a GitHub user).

## Decisions taken with the user

All are recorded in section 13 of the design document. In short:

- Classes with decorators carry the metadata (opra style); the generated ones are not edited,
  only extended.
- Choice elements are one property per type (`deceasedBoolean`), as in FHIR's JSON.
- Primitive extensions stay `_x` properties. `resourceType` is `readonly`, set by the class.
- Backbone classes are named `PatientContact`, one file per resource.
- Extension and slice sugar have their own storage.
- `decode()` picks a registered profile class from `meta.profile`.
- Package names are `@fhirjs/core`, one package per FHIR version, `@fhirjs/client` (client
  only) and `@fhirjs/server` (separate).
- FHIRPath is our own, in its own package, with a hand-written parser. Typing is strict by
  default, and `validate()` runs it lenient because R4's invariants need that.
- The client uses fetch with opra-style interceptors, and promises rather than observables. The
  user accepted the client API.

## Known gaps

- **FHIRPath suites:**
  - R4: 1,070 of 1,076 in scope pass. R4B: 1,068 of 1,074. R5: 1,221 of 1,226.
  - The known failures are listed by name in `packages/core/test/_support/fhirpath-suite.ts`.
    Five are boundary cases where the suite contradicts its own rounding rule. One
    (`testPlusDate19`) is an R4/R4B expectation that R5's suite changed.
  - Out of scope: `documentFunctions` (Java engine only), `TerminologyTests` (they need a
    terminology server), and `ccda.xml` (a CDA document).
- **Errors found in the specification itself**, and kept as known in the tests:
  - `cid-0` and `cnl-0` ask for a `name` the resource does not have.
  - R4B's `sdf-24` and `sdf-25` take the `length()` of an `ElementDefinition`.
  - R4B types `Element.id` as `id`, which its own data breaks; the generator keeps `string`.
- **Not done:**
  - Core and FHIRPath: the terminology functions (`%terminologies`), XML, and invariants of
    profiles checked when they are loaded. `check()` checks the operands of arithmetic and
    ordering; equality is left unchecked on purpose (see "FHIRPath operand types" in the design
    document).
  - IGs: no R4B or R5 IG has been tested; only US Core 6.1.0 on R4 has.
  - Client: SMART `private_key_jwt` for app launch, dynamic client registration, subscriptions, and tests against a real FHIR or authorization server.
  - The packages have no README.

## Next steps, as proposed to the user

1. `@fhirjs/server`, as designed in [`decisions/server.md`](decisions/server.md). The decisions in
   its two "Decided" sections were taken with the user; the rest is a proposal until it is built.
   Built: the package, `FhirStore` and `MemoryStore`, read and write interactions, history, and
   search with token, string, date, reference, number, quantity and uri parameters and `_sort`.
   Conditional interactions, JSON Patch and `$validate` are built too: the first version of the
   design is complete. Next: authentication and authorization, designed in
   [`decisions/server-auth.md`](decisions/server-auth.md). Built: `@fhirjs/smart`, and the
   server's authenticators (JWT, introspection, `checked()`), the authorizer interface, and
   `SmartAuthorizer` with the compartments. Batch and transaction are built, and chained search, `_has`,
   `_include` and `_revinclude` ("Built: chained search and includes" in
   [`decisions/server.md`](decisions/server.md)). The server takes one store now; `RoutingStore`
   sends types to stores of their own ("Decided: one store"). Composite parameters, `_summary` and `_elements` are built.
   A first facade store over an EMR schema in PostgreSQL is built in `examples/facade` (on sqb),
   as designed in [`decisions/facade-store.md`](decisions/facade-store.md); its "Built" section
   says what a SQL helper would take over. Encounter `date` and the `:missing` over two columns
   came in with sqb 6.3.7, which fixed a bug found here.
   The helper for SQL facades, `@fhirjs/sql`, is built as designed in
   [`decisions/sql-facade.md`](decisions/sql-facade.md), and `examples/facade` is a description
   for it; the server strips its own base from reference values. Writes through the helper are
   built ("Writes" in [`decisions/sql-facade.md`](decisions/sql-facade.md)): a table's `row()`
   maps a resource back, the store refuses what does not read back, versions come from
   `lastUpdated`, and `transaction()` runs a Bundle in one database transaction. The library's
   aim is a facade over existing systems (decided with the user, 2026-11-23), so a FHIR-shaped
   PostgreSQL store is not built: `MemoryStore` serves tests and demos. A resource over more than
   one row is built ("Child tables" in [`decisions/sql-facade.md`](decisions/sql-facade.md)): a
   child is an `SqlChild`: `childTable()`, the application's own SQL, or `linked()` over sqb
   entities (a `@Link().toMany(...)` field, sqb 6.3.8), mixed in one resource. Bulk Data export
   (`$export` of the server, the patients and a group) is built in the server, as decided in
   [`decisions/bulk-export.md`](decisions/bulk-export.md), and runs over the facade; the client
   starts one, waits for it and reads its files (`bulkExport()`); `_typeFilter`, `_elements`, the
   resources deleted since `_since` and a limit on exports at once came next, then a POST's
   `patient` and `includeAssociatedData` (Provenance). Next, to choose
   with the user: XML or subscriptions. The first release is set up as betas of 1.0.0
   ([`decisions/release.md`](decisions/release.md)). A composite on one child row, chains
   and `_has` through a child's reference, and a link with conditions (sqb 6.4.0) are built
   ("Searches through children" in [`decisions/sql-facade.md`](decisions/sql-facade.md)), and
   after them children of children, links of more hops (read) and columns by property.
2. The GitHub settings were set with the user (2026-11-23): merge commits only, a ruleset on
   `main` (no deletion, no force push), read-only default workflow permission, Dependabot alerts.
   Secret scanning and push protection still fail `repo-check`: GitHub took the request but kept
   them off, as the plan of a private repository does not have them. That is the user's to
   decide. Auto-merge is allowed; a ruleset on `dev` requires the `test` and `test-slow` checks,
   so a pull request with auto-merge waits for CI, and a push to `dev` needs them too.
3. A test against HAPI's public test server writes test data to an outside service: ask the
   user first.
