# Releases and versions

How the `@fhirjs` packages are versioned and published to npm.

## Decided (2026-11-24)

Taken with the user.

| Question            | Decision                                                                                                    | Why                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| One version or many | One version for all nine packages, one `v*` tag (lockstep, as sqb and opra)                                 | The packages depend on each other closely (`r4` on `core`, `server` on `core` and `smart`); separate versions would buy nothing          |
| The first releases  | Betas of 1.0.0: `1.0.0-beta.1`, `1.0.0-beta.2`, … under the npm dist-tag `beta`                             | The version they lead to is known from the start; the API may still change between betas                                                  |
| The FHIR version    | Not in the package version: it is in the package name (`r4`, `r4b`, `r5`)                                   | The library's version moves with the library; `@fhirjs/r4@4.0.1` would tie it to HL7's                                                    |
| How a release runs  | rman, in `release.yml` on a merge into `main` (the `panates/github-actions` release workflow), as in sqb     | The company's way: the version from the commits, the changelog, the tag, the GitHub Release and `rman publish` in one run                 |

## How it works

- `.rmanrc.yml` has `version.preid: beta`: every bump stays on the beta line, a fix or a feature
  alike (`1.0.0-beta.1` → `1.0.0-beta.2`). A new prerelease line starts at `.1` (rman 2.44.0). `rman publish` takes the dist-tag from the version, so
  `latest` is not moved by a beta. The GitHub Release is marked a prerelease.
- The first release needs `Release-As: major` in the body of a commit it holds; without it
  `0.0.0` and the features since give `0.1.0-beta.1`. The release setup commit carries it.
- For 1.0.0, remove `preid` from `.rmanrc.yml`: the next release is `1.0.0`, on `latest`.
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

## Open

- npm sets `latest` on a package's first publish whatever the dist-tag, so `npm install` gives the
  beta until 1.0.0.
- npm provenance needs a public repository, and npm's Trusted Publishing (OIDC) is set up per
  package on npmjs.com, which may need the package to exist first. Both are the user's to do.
- The npm badges of the package READMEs come after the first publish.
