# fhirjs

FHIR for Node.js: resources as typed classes, a JSON codec with validation, profiles and IG
packages, FHIRPath, and a REST client with SMART on FHIR.

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]
[![CI Tests][ci-test-image]][ci-test-url]
[![Test Coverage][coveralls-image]][coveralls-url]

The resources of each FHIR version are generated as decorated TypeScript classes. The same
classes carry what the codec needs to read, write and validate them, so a profile is a subclass
with a few more decorators. The packages are published to npm as betas of 1.0.0.

## Packages

| Package | What it is |
| ------- | ---------- |
| [`@fhirjs/core`](packages/core) | Decorators, the runtime model, the JSON codec, validation, profiles, extensions and IG packages |
| [`@fhirjs/fhirpath`](packages/fhirpath) | A FHIRPath parser, evaluator and type checker, with no dependency |
| [`@fhirjs/r4`](packages/r4) | FHIR R4 (4.0.1) resources and data types |
| [`@fhirjs/r4b`](packages/r4b) | FHIR R4B (4.3.0) resources and data types |
| [`@fhirjs/r5`](packages/r5) | FHIR R5 (5.0.0) resources and data types |
| [`@fhirjs/client`](packages/client) | A REST client with search paging, conditional interactions and SMART on FHIR |
| [`@fhirjs/server`](packages/server) | A REST server over stores of your own: in memory, or a facade over an existing database |
| [`@fhirjs/smart`](packages/smart) | SMART on FHIR building blocks: JWT verification with JWK Sets, and SMART scopes |
| [`@fhirjs/sql`](packages/sql) | A store for `@fhirjs/server` over an existing SQL database (PostgreSQL), described table by table |

## Quick start

```bash
npm install @fhirjs/core @fhirjs/r4
```

```ts
import { FhirContext } from '@fhirjs/core';
import { Patient, r4Model } from '@fhirjs/r4';

const fhir = new FhirContext(r4Model);

const patient = fhir.decode<Patient>(
  '{"resourceType":"Patient","name":[{"family":"Doe","given":["Jane"]}]}',
);
console.log(patient instanceof Patient, patient.name?.[0].family); // true Doe

console.log(fhir.stringify(new Patient({ name: [{ family: 'Kaya' }] })));
```

The classes use legacy decorators: set `"experimentalDecorators": true` in your `tsconfig.json`.

## Documentation

The design of the model and the measured results are in
[`docs/design/decorator-model.md`](https://github.com/panates/fhirjs/blob/main/docs/design/decorator-model.md),
and the decisions behind the server, SMART, the SQL facade, Bulk Data and the releases in
[`docs/decisions`](https://github.com/panates/fhirjs/tree/main/docs/decisions).
A profile with a slice and extensions is in [`examples/profile`](examples/profile), and a facade
over an EMR's PostgreSQL database in [`examples/facade`](examples/facade). Planned work is in the
[issues](https://github.com/panates/fhirjs/issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement).

## Node.js

Node.js 22 or later.

## Contributing

See [`CLAUDE.md`](CLAUDE.md) for the commands, the layout and the rules of working in this
repository.

## License

BSD-3-Clause

[npm-image]: https://img.shields.io/npm/v/@fhirjs/core
[npm-url]: https://npmjs.org/package/@fhirjs/core
[downloads-image]: https://img.shields.io/npm/dm/@fhirjs/core.svg
[downloads-url]: https://npmjs.org/package/@fhirjs/core
[ci-test-image]: https://github.com/panates/fhirjs/actions/workflows/test.yml/badge.svg?branch=dev
[ci-test-url]: https://github.com/panates/fhirjs/actions/workflows/test.yml
[coveralls-image]: https://img.shields.io/coveralls/panates/fhirjs/main.svg
[coveralls-url]: https://coveralls.io/r/panates/fhirjs
