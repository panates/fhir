# Releases and versions

How the `@fhirjs` packages are versioned and published to npm.

## Decided (2026-11-24)

Taken with the user.

| Question            | Decision                                                                                                    | Why                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| One version or many | One version for all nine packages, one `v*` tag (lockstep, as sqb and opra)                                 | The packages depend on each other closely (`r4` on `core`, `server` on `core` and `smart`); separate versions would buy nothing          |
| The first releases  | Betas of 1.0.0: `1.0.0-beta.1`, `1.0.0-beta.2`, …, each on npm's `latest`                                   | The version they lead to is known from the start; the API may still change between betas                                                  |
| The FHIR version    | Not in the package version: it is in the package name (`r4`, `r4b`, `r5`)                                   | The library's version moves with the library; `@fhirjs/r4@4.0.1` would tie it to HL7's                                                    |
| How a release runs  | rman, in `release.yml` on a merge into `main` (the `panates/github-actions` release workflow), as in sqb     | The company's way: the version from the commits, the changelog, the tag, the GitHub Release and `rman publish` in one run                 |

## How it works

- `.rmanrc.yml` has `version.preid: beta`: every bump stays on the beta line, a fix or a feature
  alike (`1.0.0-beta.1` → `1.0.0-beta.2`). A new prerelease line starts at `.1` (rman 2.44.0).
  The GitHub Release is marked a prerelease.
- `publish.npm.latestPrereleases: [beta]`: until 1.0.0 the betas are the releases, so each is
  published to `latest` (a plain `npm install` gets the newest), not to a `beta` dist-tag. Added
  after the first release (2026-11-24), which went to `beta`; `latest` was moved to it by hand.
- The first release needs `Release-As: major` in the body of a commit it holds; without it
  `0.0.0` and the features since give `0.1.0-beta.1`. The release setup commit carries it.
- For 1.0.0, remove `version.preid` and `publish.npm.latestPrereleases` from `.rmanrc.yml`: the
  next release is `1.0.0`, on `latest`, and later previews go to dist-tags of their own.
- A package is published from its `build/`: the build writes its manifest there with `README.md`
  and `LICENSE`, and rman turns `workspace:^` into the version range when it publishes.

## Measured before the first release

In throwaway worktrees, with nothing pushed:

- rman 2.43.1: nine packages `0.0.0` → `1.0.0-beta.0`, then a `feat:` commit → `1.0.0-beta.1`.
  `rman publish --dry-run` sent the nine to npm under the dist-tag `beta`, "never published".
  The first release wrote no changelog entry; reported, and fixed in rman 2.44.1
  (panates/rman#74).
- rman 2.44.1 (what `release.yml` installs, rman `2`): nine packages `0.0.0` →
  `1.0.0-beta.1`, and the release commit carries the whole history as the `v1.0.0-beta.1`
  changelog entry.

## The first release (2026-11-24)

- npm's Trusted Publishing needs a package to exist, so the user published each package once from
  a local machine as an empty `0.0.0-placeholder` (dist-tag `placeholder`), then set up a Trusted
  Publisher per package (`panates/fhirjs`, `release.yml`).
- The merge into `main` released `v1.0.0-beta.1`: seven packages published with provenance;
  `@fhirjs/server` failed its OIDC exchange (its Trusted Publisher was not right yet), and `sql`
  after it. After the fix, `release.yml` was run by hand on `main`: it published the two and made
  the GitHub Release. Its merge back into `dev` was refused by the ruleset (required checks) and
  went through a pull request (panates/fhirjs#41).
- npm had put `latest` on the placeholders; it was moved to `1.0.0-beta.1` by hand
  (`npm dist-tag add`), and the `beta` and `placeholder` dist-tags were removed
  (`npm dist-tag rm`). Each of these takes the user's npm 2FA, one approval per package and tag.

## Coverage

`release.yml` sends the coverage of the released code to Coveralls under `main`
(`coverage-publish.yaml@v3`): the `coverage/lcov.info` that `test.yml` keeps as an artifact, from
`dev`'s run of the merged commit. It covers the tests not tagged `#slow`, which run with c8. The
READMEs show the npm version, downloads, the `test.yml` result on `dev` and this coverage.
