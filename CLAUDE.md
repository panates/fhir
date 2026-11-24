# fhirjs

A FHIR library for Node.js: resources as decorated TypeScript classes, a JSON codec with
validation, profiles and IG packages, a FHIRPath engine of its own, and a REST client with SMART
on FHIR. The packages are published under the `@fhirjs` scope (not yet published).

The design and every measured result are in
[`docs/design/decorator-model.md`](docs/design/decorator-model.md) (sections 11–13). The state of
the work and what is open are in [`docs/HANDOVER.md`](docs/HANDOVER.md).

## Layout

| Folder                     | Package                                   | What it is                                                                                                                   |
| -------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`            | `@fhirjs/core`                            | Decorators, the runtime model, the codec on valgen, profiles, extensions, IG packages, invariants                            |
| `packages/fhirpath`        | `@fhirjs/fhirpath`                        | FHIRPath: lexer, Pratt parser, evaluator, `check()`. No dependency                                                           |
| `packages/r4`, `r4b`, `r5` | `@fhirjs/r4`, `@fhirjs/r4b`, `@fhirjs/r5` | Generated classes of FHIR 4.0.1, 4.3.0 and 5.0.0                                                                             |
| `packages/client`          | `@fhirjs/client`                          | REST client, SMART on FHIR                                                                                                   |
| `packages/server`          | `@fhirjs/server`                          | REST server: a fetch-style handler over stores per resource type ([design](docs/decisions/server.md)), Bulk Data `$export`   |
| `packages/smart`           | `@fhirjs/smart`                           | JWT verification (JWK Sets, key rotation) and SMART scopes, for the client and the server. No dependency                     |
| `packages/sql`             | `@fhirjs/sql`                             | A store over an existing SQL database, described table by table, on sqb (a peer dependency). PostgreSQL                      |
| `support/`                 |                                           | `build-models.mts` (the generator), `fetch-packages.mts`, benchmarks                                                         |
| `examples/`                |                                           | A profile example (`pnpm examples`); a facade store over an EMR in PostgreSQL (`examples/facade`, tested with `FHIR_PG_URL`) |

## Commands

Node 22 or later, pnpm 12.

```bash
pnpm install
pnpm fetch-packages   # HL7 packages, US Core, the FHIRPath suites (about 1.3 GB, not committed)
pnpm build            # rman build: lint, rman check (manifests, circular imports), clean, tsc
pnpm test
pnpm generate         # rewrites packages/{r4,r4b,r5}/src from the HL7 packages
pnpm format           # prettier; pnpm lint fixes what eslint can
```

Check the types of the tests with `pnpm exec tsc -p tsconfig-test.json --noEmit`. CI
(`.github/workflows/test.yml`) runs all of the above and fails when `pnpm generate` changes the
committed sources. It runs on pull requests into `dev` and on pushes to `dev`, not on a push to
a feature branch: open a pull request to get a run.

## Rules and traps

- **Run `pnpm fetch-packages` before you measure.** Without it the tests that need the HL7
  packages are skipped, and the test count is not the real one (359 with them; 396 when
  `FHIR_PG_URL` names a PostgreSQL database for `@fhirjs/sql` and the facade example, as in CI).
- **Tag a slow test `#slow`** at the end of its title: one that runs over every example of a
  version or takes about a second or more. CI runs the tagged tests in a second job, in parallel
  and without coverage (`mocha --grep '#slow'`), and the others with `--invert`. Ten are tagged;
  they take 50 of the 53 seconds of `pnpm test`.
- **Never edit `packages/{r4,r4b,r5}/src` by hand.** Change `support/build-models.mts`, run
  `pnpm generate` and commit what it writes. A generator change for one version must leave the
  others unchanged: count `@FhirElement` in each (R4 5,534, R4B 5,652, R5 7,097) and the search parameters in
  `search-parameters.ts` (R4 1,387, R4B 1,425, R5 1,239), and the compartment parameters in
  `compartments.ts` (R4 299, R4B 299, R5 291).
- **Generated classes are extended, not changed.** Profiles subclass them
  (`examples/profile/tr-patient.ts`).
- **`experimentalDecorators` stays on** (legacy decorators, as opra uses them).
- **`emitDecoratorMetadata` stays off** for the generated packages and the tests. With it on, a
  class that refers to one declared later in the same file fails with a TDZ ReferenceError
  (`TimingRepeat`).
- **Delete the `*.tsbuildinfo` files with `build/`** when you run `tsc -b` yourself (`pnpm
  check-types`): with the build info left behind it takes a package as up to date and emits
  nothing. `pnpm build` cleans both first.
- **A package is published from its `build/`** (`publishConfig.directory`), so its `exports` name
  `./index.js`, and pnpm links the workspace packages to their `build/` (`linkDirectory`): run
  `pnpm build` before `pnpm examples`. A package's `tsconfig.json` maps its siblings to their
  sources (the tests, `rman check`); the root `tsconfig-build.json` maps them to their `build/`.
- **Releases** are made by `release.yml` on a merge into `main`: one version for every package,
  a beta for now (`version.preid: beta` in `.rmanrc.yml`, each on npm's `latest`). Decided in
  [`docs/decisions/release.md`](docs/decisions/release.md).
- **valgen is Panates' own package.** Report a problem found in valgen to its maintainers; do not
  work around it or patch it here. The codec needs valgen 7.0.13 or later.
- **The FHIRPath suites are read at a fixed commit** of `FHIR/fhir-test-cases`, set in
  `support/fetch-packages.mts`. The known failures are listed by name in
  `packages/core/test/_support/fhirpath-suite.ts`; a new failure is a regression.
- **Errors in the specification are kept as known in the tests**, not worked around in the
  model: `cid-0`, `cnl-0`, R4B's `sdf-24` and `sdf-25`, and R4B's `Element.id` typed as `id`.
- **Ask before a test writes to an outside server** (for example HAPI's public test server).
- When a pull request or issue names an `@fhirjs/...` package, put it in backticks: a bare
  `@name` tags a GitHub user.
