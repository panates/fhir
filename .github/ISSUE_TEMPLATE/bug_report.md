---
name: Bug report
about: A resource read, written, validated or searched wrongly, a FHIRPath result, or an error you did not expect
title: ''
labels: bug
assignees: ''
---

**Packages and versions**
Which `@fhirjs` packages (`core`, `fhirpath`, `r4`, `r4b`, `r5`, `client`, `server`, `smart`, `sql`) and their versions. The Node.js version (`node -v`), and the TypeScript version for a typing problem.

**FHIR version and profile**
R4, R4B or R5, and the profile or IG package (name and version) if one is involved.

**The resource or expression**
The resource JSON, the FHIRPath expression or the search URL, or the smallest part of it that shows the problem.
Replace patient names, identifiers, dates of birth and addresses with made-up values first: do not post real patient data.

```json

```

**Code**
The smallest code that shows the problem.

```typescript

```

**What happens**
The output, the error and its stack, the OperationOutcome, or the wrong value.

**What you expected**
The value or behaviour you expected, and where the FHIR specification says so (a link to the page or the invariant), if you know.

**The other side**
For `client`: the server (product and version). For `server` and `sql`: the store, and for `sql` the database and its version.

Security problems are not reported here: see SECURITY.md.
