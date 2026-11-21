# @fhirjs/fhirpath

FHIRPath for Node.js: a parser and an evaluator compiled to functions, over a FHIR model of your
own.

It has no dependency. Without a model it navigates JSON keys; with one it also tests types and
checks an expression against the type of its input before running it. It passes the HL7 FHIRPath
suites of R4, R4B and R5, except for a few cases named in the repository.

## Install

```bash
npm install @fhirjs/fhirpath
```

## Usage

```ts
import { FhirPath } from '@fhirjs/fhirpath';

const fp = new FhirPath();
const patient = {
  resourceType: 'Patient',
  name: [{ use: 'official', family: 'Doe', given: ['Jane', 'Q'] }],
};

fp.evaluate(patient, "name.where(use = 'official').given.first()"); // ['Jane']

// Compile once, run many times
const hasName = fp.compile('name.exists()');
hasName.test(patient); // true
```

### With a FHIR model

[`@fhirjs/core`](https://www.npmjs.com/package/@fhirjs/core) gives the model of a FHIR version
through `fhirPathModelOf()`. With it, `check()` finds mistakes without data:

```ts
import { fhirPathModelOf } from '@fhirjs/core';
import { FhirPath } from '@fhirjs/fhirpath';
import { r4Model } from '@fhirjs/r4';

const fp = new FhirPath({ model: fhirPathModelOf(r4Model) });
fp.check("name.where(use = 'official').famly", { type: 'Patient' });
// [{ message: 'HumanName has no element "famly"', start: 0, end: 34 }]
```

Typing is strict, as the specification says. `lenient: true` lets a FHIR primitive also be its
System type, which some invariants of R4 need.

## Documentation

[The design of the library](https://github.com/panates/fhir/blob/main/docs/design/decorator-model.md)

## License

BSD-3-Clause
