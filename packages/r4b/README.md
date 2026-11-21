# @fhirjs/r4b

FHIR R4B (4.3.0) resources and data types as decorated classes, for `@fhirjs/core`.

Every resource, data type and backbone element of FHIR 4.3.0 is a class, generated from the
`hl7.fhir.r4b.core` package. The codes of required value sets are typed. `r4bModel` holds them
all, for [`@fhirjs/core`](https://www.npmjs.com/package/@fhirjs/core) to read, write and
validate them.

## Install

```bash
npm install @fhirjs/core @fhirjs/r4b
```

The classes use legacy decorators: set `"experimentalDecorators": true` in your `tsconfig.json`.

## Usage

```ts
import { FhirContext } from '@fhirjs/core';
import { Patient, r4bModel } from '@fhirjs/r4b';

const fhir = new FhirContext(r4bModel);

const patient = new Patient({ name: [{ family: 'Doe', given: ['Jane'] }], gender: 'female' });
const json = fhir.stringify(patient);
const back = fhir.decode<Patient>(json);
```

To add a profile, extend a class here with the decorators of `@fhirjs/core`; see
[`examples/profile`](https://github.com/panates/fhir/tree/main/examples/profile).

## Documentation

[The design of the model](https://github.com/panates/fhir/blob/main/docs/design/decorator-model.md)

## License

BSD-3-Clause
