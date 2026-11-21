# @fhirjs/core

FHIR object model, codecs, profiles and package loading for Node.js.

Resources are classes with decorators. `FhirContext` reads them from JSON (`decode`), writes them
back (`encode`, `stringify`) and checks them (`validate`): structure, cardinality, required
bindings, profiles, extensions and the FHIRPath invariants. The classes of a FHIR version come
from [`@fhirjs/r4`](https://www.npmjs.com/package/@fhirjs/r4),
[`@fhirjs/r4b`](https://www.npmjs.com/package/@fhirjs/r4b) or
[`@fhirjs/r5`](https://www.npmjs.com/package/@fhirjs/r5).

## Install

```bash
npm install @fhirjs/core @fhirjs/r4
```

The classes use legacy decorators: set `"experimentalDecorators": true` in your `tsconfig.json`.

## Usage

```ts
import { FhirContext } from '@fhirjs/core';
import { Patient, r4Model } from '@fhirjs/r4';

const fhir = new FhirContext(r4Model);

// JSON in, class instance out
const patient = fhir.decode<Patient>(
  '{"resourceType":"Patient","name":[{"family":"Doe","given":["Jane"]}],"gender":"female"}',
);

// Class instance in, JSON out
console.log(fhir.stringify(new Patient({ name: [{ family: 'Kaya' }], birthDate: '1990-01-01' })));

// Validation lists the issues instead of throwing
const result = fhir.validate({ resourceType: 'Patient', gender: 'unknown-value' });
console.log(result.valid, result.issues.map(i => i.diagnostics));
```

### Implementation guides

`FhirPackageCache` reads packages from `~/.fhir/packages`, the folder HAPI, Firely and the IG
Publisher share, and downloads missing ones from packages.fhir.org when allowed. The profiles,
extensions and value sets of a package then check the resources that name them in
`meta.profile`.

```ts
import { FhirContext, FhirPackageCache } from '@fhirjs/core';
import { r4Model } from '@fhirjs/r4';

const cache = new FhirPackageCache({ download: true });
const { packages } = await cache.resolve('hl7.fhir.us.core', '6.1.0');
const fhir = new FhirContext(r4Model, { packages });
```

### Profiles in code

A profile is a subclass of a generated class with `@FhirProfile`, `@FhirSlice` and
`@FhirExtension`. Pass it in `types` and `decode()` picks it from `meta.profile`. A complete
example is in
[`examples/profile`](https://github.com/panates/fhir/tree/main/examples/profile).

## Documentation

[The design of the model](https://github.com/panates/fhir/blob/main/docs/design/decorator-model.md)

## License

BSD-3-Clause
