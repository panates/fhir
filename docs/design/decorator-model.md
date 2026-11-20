# Design: decorator-based object model

Status: plan for discussion. Replaces section 3 and 3.1 of [object-model.md](object-model.md)
(generated classes without decorators, metadata in a data file). Sections 4 to 6 there (user API,
codec, validation) still apply and run on the metadata described here.

## 1. Principles

1. **A type and its metadata are defined in one place: the class, with decorators**, as in opra.
   This holds for the generated core types and for the types a developer writes.
2. **Generated classes are not changed.** A developer extends them (a subclass) or replaces one
   for a context (section 9). Changing a generated class means forking the repository.
3. **One set of decorators** for core types, profiles and extensions. What a developer reads in
   `Patient` is what they write in `TrPatient`.
4. **Decorators only record.** They store their options on the class. Building the runtime model,
   codecs and validators happens on first use, so importing the classes stays cheap.
5. **What is not a type stays data**: value set codes, code systems, search parameters, and
   profiles loaded from IG packages at run time.

## 2. Decorator flavour: legacy

Generated fields are `declare`d: they must not exist on an instance until set, or every object
would carry dozens of `undefined` keys. Checked with TypeScript 6.0.3:

| Flavour                         | `@Dec() declare name?: string`              | `@Dec() name?: string`                         |
| ------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| TC39 standard                   | error TS1206 "Decorators are not valid here" | Works, but every instance gets an own `name: undefined` |
| Legacy (`experimentalDecorators`) | Works; no own key on the instance          | Works                                          |

So: legacy decorators, the same as opra and sqb. `reflect-metadata` is not needed: every
decorator states its type (`type: () => HumanName`), so `emitDecoratorMetadata` is not used.
Metadata is stored under a symbol on the constructor.

## 3. Runtime metadata model

The decorators feed an opra-like model, one per FHIR version:

```
FhirModel (R4)                         ≈ opra ApiDocument
├─ PrimitiveType   string, code, date, decimal, ...         ≈ SimpleType
├─ ComplexType     HumanName, Quantity, Extension, ...      ≈ ComplexType
│  └─ BackboneType Patient.contact, Observation.component, ...
├─ ResourceType    Patient, Observation, Bundle, ...
├─ ProfileType     TrPatient, US Core Patient, ...          (constrains a base type)
└─ ExtensionType   religion, birthPlace, ...                (an Extension with a fixed url)

Each complex type has FhirElement objects       ≈ ApiField
```

```ts
interface FhirElement {
  name: string;               // 'name', or 'deceased[x]' for a choice
  path: string;               // 'Patient.name'
  owner: ComplexType;         // where it is defined or overridden
  types: FhirElementType[];   // one, or more for a choice
  min: number;
  max: number;                // Infinity for '*'
  isArray: boolean;
  binding?: FhirBinding;
  summary?: boolean;
  modifier?: boolean;
  mustSupport?: boolean;
  fixed?: unknown;
  pattern?: unknown;
  slices?: FhirSlice[];       // profiles
  constraints?: FhirConstraint[];
  description?: string;
}
```

`model.getType('Patient').getElement('name')`, `model.findType(url)`, `model.resources()` are the
introspection API. The codec, the validator, the client's typed search and documentation tools
all read this model.

## 4. Decorators

| Decorator                     | On       | Purpose                                                       |
| ----------------------------- | -------- | ------------------------------------------------------------- |
| `@FhirPrimitiveType(opts)`    | class    | A primitive: name, regex, JSON form; `[DECODER]`/`[ENCODER]` methods as in opra's `SimpleType` |
| `@FhirComplexType(opts)`      | class    | A data type: name, url, abstract                              |
| `@FhirBackboneType(opts)`     | class    | A backbone element: its path (`Patient.contact`)              |
| `@FhirResource(opts)`         | class    | A resource: name, url, abstract                               |
| `@FhirElement(opts)`          | property | An element: type, min, max, choice, binding, flags, fixed, pattern |
| `@FhirConstraint(opts)`       | class or property | An invariant: key, severity, human, FHIRPath expression (repeatable) |
| `@FhirProfile(opts)`          | class    | A profile on the class it extends: url, name                  |
| `@FhirExtension(opts)`        | property | Sugar: a property that is an `extension` entry on the wire    |
| `@FhirExtensionType(opts)`    | class    | Defines an extension (url, context, value type or sub-extensions) |
| `@FhirSlice(opts)`            | property | Sugar: a property that is one slice of a sliced element       |

Element options:

```ts
interface FhirElementOptions {
  type: FhirTypeRef | FhirTypeRef[];      // 'string' | () => HumanName | [() => Reference, 'Patient', 'Group']
  min?: number;                            // default 0
  max?: number | '*';                      // default 1
  choice?: string;                         // 'deceased[x]': this property is one of its types
  binding?: { strength: BindingStrength; valueSet: string | ValueSetRef };
  summary?: boolean;
  modifier?: boolean;
  mustSupport?: boolean;
  fixed?: unknown;
  pattern?: unknown;
  contentRef?: string;                     // '#Questionnaire.item'
  description?: string;
}
```

A type is a **name** (`type: 'HumanName'`) or a **thunk** (`type: () => HumanName`):

- Generated classes use names. The model resolves them among its registered classes, so a
  generated file imports only its base class as a value and everything else with `import type`.
  This avoids ES module import cycles (`Element.extension: Extension` while
  `Extension extends Element` would fail at load time). Found in the R4 trial (section 11).
- Developer classes may use thunks, as opra's `TypeThunkAsync`, or names.

## 5. Generated core types

One file per resource, with its backbone types; one file per data type. Primitive types are
hand-written in the core package (about twenty).

```ts
// @fhirjs/r4: packages/r4/src/resources/patient.ts  (generated, do not edit)

@FhirResource({ url: 'http://hl7.org/fhir/StructureDefinition/Patient' })
@FhirConstraint({ key: 'pat-1', severity: 'error',
  human: 'SHALL at least contain a contact\'s details or a reference to an organization',
  expression: 'name.exists() or telecom.exists() or address.exists() or organization.exists()',
  path: 'contact' })
export class Patient extends DomainResource {
  declare readonly resourceType: 'Patient';

  @FhirElement({ type: () => Identifier, max: '*', summary: true })
  declare identifier?: Identifier[];

  @FhirElement({ type: 'boolean', modifier: true, summary: true })
  declare active?: boolean;
  declare _active?: Element;

  @FhirElement({ type: () => HumanName, max: '*', summary: true })
  declare name?: HumanName[];

  @FhirElement({ type: 'code', summary: true,
    binding: { strength: 'required', valueSet: 'http://hl7.org/fhir/ValueSet/administrative-gender|4.0.1' } })
  declare gender?: AdministrativeGender;
  declare _gender?: Element;

  @FhirElement({ type: 'date', summary: true })
  declare birthDate?: FhirDate;
  declare _birthDate?: Element;

  @FhirElement({ choice: 'deceased[x]', type: 'boolean', modifier: true, summary: true })
  declare deceasedBoolean?: boolean;

  @FhirElement({ choice: 'deceased[x]', type: 'dateTime', modifier: true, summary: true })
  declare deceasedDateTime?: FhirDateTime;

  @FhirElement({ type: () => PatientContact, max: '*' })
  declare contact?: PatientContact[];

  @FhirElement({ type: [() => Reference, 'Organization'], summary: true })
  declare managingOrganization?: Reference<'Organization'>;
  // ...
}

@FhirBackboneType({ path: 'Patient.contact' })
export class PatientContact extends BackboneElement {
  @FhirElement({ type: () => CodeableConcept, max: '*' })
  declare relationship?: CodeableConcept[];

  @FhirElement({ type: () => HumanName })
  declare name?: HumanName;
  // ...
}
```

Rules the generator follows:

- **Primitive extensions** (`_birthDate`) are declared without a decorator. The model derives
  them: every element of a primitive type has one.
- **Choice elements**: one decorated property per allowed type, all with the same `choice`. The
  model joins them into one element `deceased[x]`; the codec allows at most one of them.
- **Required bindings** get a string union type (`AdministrativeGender`) generated next to the
  class; the codes are also in the version's value set data.
- **Inherited elements** (`id`, `meta`, `extension`, ...) are declared once, in `Resource`,
  `DomainResource`, `Element`, `BackboneElement`.
- **Constructor**: `new Patient(init?: FhirInit<Patient>)` assigns the given values, as opra's
  `new Note(init)`. `resourceType` is set by the class.

## 6. Developer types: profiles

A profile constrains its base. It is not a new type on the wire: `resourceType` stays `Patient`,
and `encode()` adds the profile's url to `meta.profile`.

```ts
@FhirProfile({ url: 'http://example.org/fhir/StructureDefinition/tr-patient' })
export class TrPatient extends Patient {
  /* Tighten an inherited element: re-declare it, give only what changes */
  @FhirElement({ min: 1 })
  declare identifier: Identifier[];

  @FhirElement({ min: 1, max: 1 })
  declare birthDate: FhirDate;

  /* A slice of identifier, as its own property (section 8) */
  @FhirSlice({ element: 'identifier', name: 'tckn', min: 1, max: 1,
    pattern: { system: 'urn:oid:2.16.840.1.113883.3.9900.1' } })
  declare tckn: Identifier;

  /* An extension, as its own property (section 7) */
  @FhirExtension({ type: () => ReligionExtension })
  declare religion?: CodeableConcept;
}
```

Rules, checked when the model is built (a broken profile fails early, not while decoding):

- `min` may only grow, `max` only shrink; `types` must be a subset of the base's; a binding may
  only get stronger; `fixed`/`pattern` must fit the base type.
- Options not given are inherited from the base element.
- A new element (not in the base) is an error: a profile cannot add elements, only extensions
  and slices.

## 7. Developer types: extensions

```ts
@FhirExtensionType({
  url: 'http://example.org/fhir/StructureDefinition/religion',
  context: ['Patient'],
  value: { type: () => CodeableConcept, binding: { strength: 'extensible', valueSet: '...' } },
})
export class ReligionExtension extends Extension {}

/* A complex extension: sub-extensions instead of a value */
@FhirExtensionType({ url: 'http://example.org/fhir/StructureDefinition/nationality', context: ['Patient'] })
export class NationalityExtension extends Extension {
  @FhirExtension({ url: 'code', type: () => CodeableConcept, min: 1 })
  declare code: CodeableConcept;

  @FhirExtension({ url: 'period', type: () => Period })
  declare period?: Period;
}
```

A property with `@FhirExtension` is the extension's **value** in code and an `extension` entry on
the wire:

```ts
p.religion = { coding: [{ code: 'M' }] };
fhir.encode(p).extension;
// [{ url: 'http://example.org/fhir/StructureDefinition/religion', valueCodeableConcept: { coding: [...] } }]
```

`decode()` moves the matching entry from `extension` to `religion`; entries no property claims
stay in `extension`. `p.extension` and `getExtension(p, url)` keep working for everything.

## 8. Developer types: slices

Slicing (identifiers by system, components by code, Bundle entries by resource type) is the
hardest part of profiles. `@FhirSlice` lets a slice be a property:

- `element`: the sliced element of the base (`identifier`);
- `discriminator`: taken from `pattern`/`fixed` by default (`value` on `system`), or given;
- on decode, entries matching the slice move to the property; others stay in the element;
- on encode, the property is written back into the element, in slice order;
- validation checks each slice's `min`/`max` and that every entry matches at most one slice.

A slice with `max: '*'` is an array property.

## 9. Registration and context

```ts
const fhir = new FhirContext('R4', {
  profiles: [TrPatient],                 // developer classes
  extensions: [ReligionExtension, NationalityExtension],
  packages: [usCore],                    // IG profiles as data (no classes)
  replace: [[HumanName, MyHumanName]],   // a subclass used wherever HumanName is
});
```

How `decode()` picks a class:

1. the class given to the call (`fhir.decode(json, TrPatient)`);
2. a registered profile class whose url is in `meta.profile`;
3. the core class for `resourceType`, or its `replace` entry.

Profiles from IG packages have no class: their instances are the base class, and `validate()`
checks them against the loaded definition.

`replace` is the way to change a core type for a whole context without forking: the subclass may
add methods or extension and slice properties, under the same rules as a profile.

## 10. Lifecycle and cost

| When                      | What happens                                                      |
| ------------------------- | ----------------------------------------------------------------- |
| Import of a class         | Decorators store their options under a symbol. Nothing else.      |
| `new FhirContext(...)`    | Registers classes by name and url. No type is built yet.          |
| First use of a type       | Its `ComplexType` is built from the stored options and checked (profile rules). |
| First codec for a type    | A `valgen` validator is generated and cached per (type, options). |

To measure with real data before deciding (needs `hl7.fhir.r4.core`):

- import time of all R4 classes;
- size of the generated JavaScript (decorator calls are emitted for every element);
- `tsc` time for a project importing `@fhirjs/r4`.

## 11. R4 trial (2026-11-20)

Code: `support/fetch-packages.mts`, `support/build-models.mts` (generator),
`packages/r4/test/r4-model.spec.ts` (check), `packages/core` (decorators, `FhirModel`),
`packages/r4/src` (generated; was `packages/models/src/r4`).

Source: `hl7.fhir.r4.core#4.0.1` (12.8 MB download, 658 StructureDefinitions).

| Measure                                   | Result                                              |
| ----------------------------------------- | --------------------------------------------------- |
| Generated classes                         | 682: 148 resources, 41 data types, 473 backbones, 20 primitives; 190 files |
| Required `code` bindings typed as unions  | 317 (245 union types); 13 stay `string` (mimetypes, currencies, languages: external code systems) |
| Generator run                             | about 1 s, with Prettier                            |
| Generated size                            | 1.5 MB TypeScript; 1.3 MB JavaScript (133 KB gzip); 0.8 MB declarations |
| `@FhirElement` calls at import            | 5,534                                               |
| Import of all R4 classes (Node 24)        | 48 ms                                               |
| Building every type of the model          | 3.7 ms                                              |
| Compare with source snapshots             | 7,406 elements: min, max, types, targets, bindings, summary, modifier; 0 differences |
| `tsc` build of the models package         | about 1 s                                           |
| `tsc` of a consumer using Patient, Observation, Bundle | 0.5 s total, 0.3 s check; wrong codes (`'femal'`, `'done'`) are compile errors |

Findings:

- **`emitDecoratorMetadata` must be off for the generated package.** With it on, TypeScript emits
  `__metadata("design:type", TimingRepeat)` for a backbone declared later in the same file, which
  throws at load time ("Cannot access 'TimingRepeat' before initialization"). The generated
  classes give every type explicitly, so the metadata is not needed. The package ships compiled,
  so this does not affect developers' own `tsconfig` (they may keep it on, as in opra).
- **Type names instead of thunks** for generated code (section 4).
- **Nested values stay plain objects**: `new Patient({ name: [{ family: 'Y' }] }).name[0]` is not
  a `HumanName` instance. Turning them into instances is the codec's job (decode); the
  constructor only assigns.

Not done in the trial:

- profiles (43 resource profiles, 5 data type profiles) and extension definitions (396) of the
  core package;
- `Reference<'Patient'>` typed by target; `Bundle.entry.resource` is typed `Resource`, not a union
  of all resources;
- validation beyond the codec (bindings, invariants, profiles);
- R4B and R5.

## 12. Codec (2026-11-20)

Code: `packages/core/src/codec/` (`FhirCodecs`, `primitiveCodec`), `packages/core/src/fhir-context.ts`
(`FhirContext`), `packages/r4/test/r4-codec.spec.ts` and `r4-examples.spec.ts` (checks),
`support/bench-codec.mts` (speed).

```ts
const fhir = new FhirContext(r4Model);            // options: unknownElements, partial, plain
const p = fhir.decode(jsonOrText);                // class from resourceType: a Patient
const p2 = fhir.decode(json, Patient);            // fails unless resourceType is Patient
const out = fhir.encode(p);                       // JSON object, keys in definition order
fhir.stringify(p, { space: 2 });
// failures: FhirCodecError { issues: [{ severity, code, expression: 'Patient.name[0].given[1]', diagnostics }] }
```

Each type gets a codec built from the model on first use and cached per mode and options: one
valgen `vg.isObject` per type, as opra's `generateCodec`, with a pre-pass for what valgen has no
notion of (cardinality counting `_x`, choices, `_x` pairing). Every codec is a valgen validator,
so it can sit inside an opra schema as it is; its issues carry their OperationOutcome type as
`fhirCode`:

```ts
const body = vg.isObject({ patient: vg.required(fhir.codecs('decode').toValidator('Patient')) });
```

The codec went from valgen to a walker of its own and back; see "Speed" below. FHIR rules on top
of the object walk:

| Rule                                   | How                                                              |
| -------------------------------------- | ---------------------------------------------------------------- |
| Instances                              | decode creates the generated classes at every level (`ctor`); `plain: true` gives plain objects |
| Polymorphic resources                  | `contained`, `Bundle.entry.resource`, `Parameters.parameter.resource`: the class from `resourceType` |
| Primitive extensions                   | `_x` is an `Element`; `_x` alone counts as presence; arrays: same length, `null` paired with a non-null |
| Choice                                 | at most one of `deceasedBoolean`, `deceasedDateTime`             |
| Cardinality                            | `min` (skipped with `partial`), `max`, no empty arrays           |
| Empty values                           | `""`, `{}`, `[]` fail                                            |
| Unknown elements                       | `'error'` (default), `'keep'` or `'drop'`                        |
| Primitives                             | JSON type, 32-bit integer ranges, the specification's regex      |
| Required bindings                      | codes in the value set (see below); `bindings: false` turns it off |
| Encode                                 | `Date` accepted for `date`, `dateTime`, `instant`; keys in definition order; `resourceType` filled in |

Regexes: the specification writes them for XML Schema, where `\s` is only space, tab, CR and LF.
In JavaScript `\s` also takes U+00A0 and other Unicode spaces, so `[ \r\n\t\S]+` rejected
`" Seul"` (starting with a no-break space). `xsdToJsRegex()` converts them.

Results on `hl7.fhir.r4.examples#4.0.1` (5,309 resources, 190 MB of JSON):

| Measure                         | Result                                                          |
| ------------------------------- | --------------------------------------------------------------- |
| Round trip (decode, encode, deep-equal to the source) | 5,296 identical; 0 differ                 |
| Decode failures                 | 13, all real errors in the examples: Questionnaire items without `linkId` (32 issues), SearchParameters without `base` (10), ImplementationGuide without `name`, `status` |
| Speed (Node 24, warm)           | Patient example (2.5 KB): decode 5.1 µs, encode 5.3 µs; Observation (1.7 KB): 1.8 µs, 1.9 µs. Less than `JSON.parse` + `JSON.stringify` of the same resource (7.7 µs, 3.0 µs) |
| Whole package                   | decode 0.21 s, encode 0.20 s                                    |

Not done:

- Warnings (unknown elements kept with `'keep'` are not reported), `_summary` / `_elements`.

Speed. The valgen version took 176 µs for the Patient example. A CPU profile showed 77% of the
time in valgen itself: `isObject`'s loop over every schema key, present or not (39%;
`Extension` has about 100 keys: 50 `value[x]` types and their `_x`), `Context.extend()` for
every nested call (19%) and the validator wrapper (19%). The walker over the input's own keys
takes 5.1 µs, 34 times less, with the same results on the 5,309 examples.

Decision (2026-11-20): the walker is temporary. The findings went to valgen; once valgen is
fixed, the codec moves back to valgen (`isObject` per type, as opra), because valgen also handles
optional and required keys. The move is to be measured against the walker's numbers above.

Back on valgen (2026-11-20). valgen 7.0.11 and 7.0.12 took up the findings (context copies
instead of prototype chains, `isObject` walking own keys and only the non-optional schema keys
the input lacks, no context per object for build-time options). A pure-valgen prototype of the R4
codecs went from 23.9 µs (7.0.11) to 7.9 µs (7.0.12) on the Patient example, against the walker's
5.0 µs, so the codec moved back. All 76 tests pass unchanged, apart from the valgen adapter test:
a codec is now a valgen validator itself, so an issue inside an opra schema has a valgen location
(`patient.birthDate`) and message, and `fhirCode`.

| Per resource (Node 24, warm) | Walker | valgen 7.0.12 | valgen 7.0.13 |
| ---------------------------- | ------ | ------------- | ------------- |
| Patient example: decode(obj) / encode | 5.5 / 5.8 µs | 9.4 / 13.9 µs | 8.7 / 8.6 µs |
| Observation example | 1.9 / 1.9 µs | 3.0 / 4.5 µs | 2.8 / 2.7 µs |
| Bundle example | 2.0 / 2.1 µs | 3.6 / 4.9 µs | 3.2 / 3.2 µs |
| Blood pressure with the US Core profile / without | 4.6 / 2.5 µs | 8.0 / 4.5 µs | 7.5 / 4.0 µs |
| Whole examples package: decode(text) / stringify | 586 / 375 ms | 735 / 1669 ms | 656 / 457 ms |

With 7.0.12, encode was the slower side: its input is an instance of a generated class, and
valgen's shortcut for the keys an object lacks applied to plain objects only (the same Patient
encoded in 13.2 µs as an instance, 9.3 µs as a plain object). Reported to valgen; 7.0.13 works out
once per prototype which absent keys can matter, so an instance of a generated class (no
enumerable data on its prototype) is as fast as JSON input: 8.9 µs instance, 8.6 µs plain. No
codec change was needed. The codec is now about 1.5 times the walker on decode and encode.

### Required bindings (2026-11-20)

The generator also writes the codes of the value sets of required bindings as data
(`value-set-data.ts`, `R4_VALUE_SETS`: canonical URL, code system, codes), and the index gives
them to the model (`new FhirModel(version, types, { valueSets })`, `model.getValueSet(url)`,
`model.addValueSets()` for more). The codec checks every element with a required binding whose
value set the model has, on decode and on encode:

| Element type      | Check                                                                 |
| ----------------- | --------------------------------------------------------------------- |
| `code` (and other primitives) | the code is in the value set                              |
| `Coding`, `Quantity` | system and code (code alone when there is no system)               |
| `CodeableConcept` | at least one coding is in the value set; text only fails              |

Value sets are listed from the package: an expansion when it has one, otherwise the compose
(whole code systems, listed concepts, nested value sets, excludes); abstract and not-selectable
concepts are left out. A value set with a filter, or on a code system the package does not hold,
cannot be listed; its bindings are not checked.

| Measure                                       | Result                                          |
| --------------------------------------------- | ----------------------------------------------- |
| Required bindings in R4                       | 362: 348 on `code`, 14 on `CodeableConcept`     |
| Value sets listed                             | 220; 4 not listable (mimetypes, UCUM units, a LOINC answer list, currencies), 17 bindings |
| Data size                                     | 80 KB JavaScript, 12 KB gzip                    |
| R4 examples                                   | no binding errors (same 5,296 round trips)      |
| Mutation check                                | the first required code of 5,190 examples set to an invalid one: 5,190 caught |
| Speed                                         | unchanged (Patient example decode 4.9 µs)       |

Extensible and preferred bindings are not checked by the codec: they belong to validation, as
warnings.

### Decimal precision (2026-11-20)

FHIR keeps a decimal's precision as written: `1.50` is not `1.5`. A JavaScript number cannot
hold that, and `JSON.parse` has already dropped the zero before the codec runs.

How it works (`packages/core/src/decimal.ts`):

- The model value stays a `number` (`quantity.value * 2` works; the TypeScript type is unchanged).
- `fhir.decode(text)` reads the JSON with the reviver's source text (`JSON.parse` source text
  access, in Node 21+; checked on Node 22.22 and 24.15). A number whose text `String(number)`
  would not give back (`1.50`, `1.5E1`, more digits than a double holds) has its text kept in a
  non-enumerable symbol property of the object or array holding it, by key. A quick regex on the
  text decides whether the reviver is needed at all.
- The codec carries the text over to the decoded instance and to `encode()`'s output.
- `fhir.stringify()` writes the kept text with `JSON.rawJSON`, so `1.50` comes back as `1.50`.
- The text counts only while it still reads as the number: a value changed in code is written as
  the new number.
- `getDecimalText(holder, key)` reads the text; `setDecimal(holder, key, '2.50')` sets a value
  with its precision.
- `decimals: 'number'` skips all of it.

Limits: `encode()` returns numbers (an object cannot hold `1.50` as a number), and a plain
`JSON.stringify` of an instance or of `encode()`'s result writes `1.5`; only `fhir.stringify()`
keeps the text. `decode(object)` of an object the caller parsed has no text to keep.

| Measure                                     | Result                                                    |
| ------------------------------------------- | --------------------------------------------------------- |
| R4 examples with numbers `JSON.parse` changes | 42 files, 319 numbers: all written back as in the source by `decode(text)` then `stringify()` |
| Files where the reviver runs                | about 42 of 5,311 (the regex only matches numbers in value position; OIDs and versions in strings do not trigger it) |
| `decode(text)`, Patient example (no such numbers) | 14.1 µs exact, 10.5 µs with `decimals: 'number'` (the regex scan) |
| `decode(text)`, an Observation with such numbers | 15.1 µs exact, 4.9 µs with `decimals: 'number'` (the reviver) |

### Profiles and extensions (2026-11-20)

Sections 6 to 9 are implemented, with the defaults proposed in section 13: extension and slice
properties hold their own values (point 3), and `decode()` picks a profile class from
`meta.profile` when the class is registered (point 5). Code: `packages/core/src/decorators.ts`,
`fhir-model.ts` (`_constrain`, extensions, slices), `codec/fhir-codecs.ts` (`decodeSugar`,
`encodeSugar`, `patternCheck`). Example and checks: `examples/profile/` (`pnpm examples`).

```ts
const fhir = new FhirContext(r4Model, { types: [TrPatient, ReligionExtension, NationalityExtension] });
// the context gets its own model (r4Model.extend(types)); r4Model is not changed
```

What it does:

| Part | Behaviour |
| ---- | --------- |
| `@FhirProfile({ url })` | `@FhirElement` on an inherited property merges over the base element. Checked when the type is built: `min` only up, `max` only down, `type` only one of the base's (narrows a choice), binding only stronger, no new elements. A broken profile throws a `TypeError` naming the property. |
| `@FhirExtensionType({ url, value? })` | With `value`: a simple extension, `value[x]` narrowed to that type and required. Without: a complex one, its parts are `@FhirExtension` properties with relative URLs (`'code'`). `url` is checked on decode and filled in on encode. |
| `@FhirExtension({ extension } \| { url, type })` | decode: matching entries of `extension` (or `modifierExtension`) leave the array; the property gets the value (simple) or a definition instance (complex). Entries no property claims stay. encode: the property is written back as entries after the others. `min`/`max` checked; decimal precision carried. |
| `@FhirSlice({ element, name, pattern })` | decode: items matching the pattern leave the element and go to the property; encode: written back first, the pattern's values filled in (`{ value: '1' }` gets the `system`). `min`/`max` checked. |
| Element `pattern` / `fixed` | checked on the value |
| `meta.profile` | encode adds the profile's URL; decode with `profiles: false` ignores it |

Decode reports a missing part at its place in JSON (`Patient.extension[1].extension`); encode at
the property (`TrPatient.tckn`).

Checks (`packages/r4/test/profile.spec.ts`; `examples/profile/` shows the use): class picked from `meta.profile`; slice and
extensions moved to properties and back (a round trip keeps every entry, order aside); a
`TrPatient` built in code gets the pattern and `meta.profile`; missing `tckn` and `birthDate`
fail; a complex extension without its required part fails; a simple extension with the wrong
value type fails; a decimal extension keeps `3.50`; without registration the JSON is a plain
`Patient`; a profile that loosens `max` or adds an element throws. The earlier checks are
unchanged (7,406 elements, 5,296 round trips, 42 decimal files).

Speed: the `TrPatient` JSON of the example decodes in 2.0 µs as `TrPatient` and 0.9 µs as a
plain `Patient` (claimed extensions are decoded twice: as `Extension`, then by their definition).

Not done:

- The generator does not write `@FhirProfile` classes for packages yet (packages load as data,
  see "Package loading").
- Discriminators other than a pattern (by type, by profile, `exists`); re-slicing; slices of
  slices.
- Order: on encode, extension properties go after the other entries and slice items before the
  other items, so a round trip can change the order within those arrays.
- A profile class needs its own constructor for typed `new TrPatient({ ... })`
  (`constructor(init?: FhirInit<TrPatient>) { super(init as FhirInit<Patient>) }`).
- Invariants (FHIRPath) of profiles.

### Tests (2026-11-20)

The checks of sections 11 and 12 are mocha tests, set up as in hl7v2 (`.mocharc.cjs`,
`@swc-node/register`, `tsconfig-test.json` mapping the packages to their sources; `pnpm test`,
`pnpm citest` for coverage). The tests run from the sources; `emitDecoratorMetadata` is off in
`tsconfig-test.json` for the reason in section 11.

| File | What |
| ---- | ---- |
| `packages/core/test/primitive-codec.spec.ts` | primitive codecs, XML Schema regexes, issue paths |
| `packages/core/test/decimal.spec.ts` | source text of decimals, the regex that decides on the reviver |
| `packages/r4/test/r4-model.spec.ts` | the R4 model; element by element against `hl7.fhir.r4.core` |
| `packages/r4/test/r4-codec.spec.ts` | decode, encode, bindings, decimals, the valgen adapter |
| `packages/r4/test/r4-examples.spec.ts` | every example of `hl7.fhir.r4.examples`: round trip, the 13 invalid ones by name, decimal precision |
| `packages/r4/test/profile.spec.ts` | profiles, extensions, slices, profile rules |
| `packages/r4/test/us-core.spec.ts` | US Core 6.1.0 loaded as data, alone and with its dependencies |
| `packages/core/test/package-cache.spec.ts` | `.tgz` reading, the cache, download from a local registry, dependency order, `../` in names |
| `packages/r5/test/r5.spec.ts` | the R5 model against `hl7.fhir.r5.core`, R5 codec cases, every example of `hl7.fhir.r5.examples` |
| `packages/r4/test/core-package.spec.ts` | the R4 core package as data: its profiles and extension definitions, every example against them |
| `packages/fhirpath/test/parser.spec.ts`, `evaluate.spec.ts` | the FHIRPath lexer, parser and evaluator without a model |
| `packages/r4/test/fhirpath.spec.ts` | FHIRPath over the R4 model; every R4 invariant on the R4 examples against fhirpath.js |
| `packages/r4b/test/r4b.spec.ts`, `validate.spec.ts` | the R4B model against `hl7.fhir.r4b.core`, codec cases, every example of `hl7.fhir.r4b.examples`, `validate()` on every example |
| `packages/client/test/fhir-client.spec.ts` | the REST client against a small in-memory FHIR server on localhost (`test/_support/test-server.ts`) |
| `packages/{r4,r4b,r5}/test/fhirpath-suite.spec.ts` | HL7's official FHIRPath test suites (R4, R4B, R5), with their inputs; the known failures by name (driver: `packages/core/test/_support/fhirpath-suite.ts`) |
| `packages/r4/test/validate.spec.ts` | `validate()`: invariants with the codec's issues, warnings, instances, OperationOutcome, `memberOf`, every R4 example |

The model and example checks every version shares are in `packages/core/test/_support/conformance.ts`.
203 tests pass (since "SMART: the id_token"); the two packages are type-checked (`tsc -p packages/<pkg>/test/tsconfig.json`).
Coverage of `packages/core`: 88% of lines, 85% of branches. Tests that need the HL7 packages are
skipped when `support/fetch-packages.mts` has not been run.

The stricter decimal test found a case the earlier script missed: `Observation-body-height.json`
has `66.899999999999991` (17 significant digits, 15 after the point), which the reviver regex did
not catch. It now looks at the length of the whole number.

### Package loading (2026-11-20)

An implementation guide's package loads as data: profiles and extension definitions without
classes, and the codes of its value sets. Code: `packages/core/src/package/`
(`FhirPackage`, `ProfileBuilder`, `resolveValueSets`), `FhirModel.loadPackage()`; tests:
`packages/r4/test/us-core.spec.ts`.

```ts
const usCore = FhirPackage.fromDirectory('…/hl7.fhir.us.core#6.1.0/package');
const fhir = new FhirContext(r4Model, { packages: [usCore] });
fhir.packageReports[0]; // { profiles: 49, extensions: 10, valueSets: 56, valueSetsNotListed: [...], warnings: [...] }
fhir.decode(json);      // checked against every loaded profile in meta.profile; instances of the generated classes
fhir.encode(p, 'USCorePatientProfile'); // checked against a profile by name; adds meta.profile
```

How a profile is read (from the snapshot, which published packages have):

- **Elements** of the base type that the snapshot tightens (`min`, `max`, binding, `fixed[x]`,
  `pattern[x]`, types of a choice) become a profile type built on the base type, through the same
  merge as `@FhirElement` on a profile class (section 6), with the same rules.
- **Nested content**: when the snapshot constrains inside an element (`Patient.identifier.system`
  1..1), the element gets its own constrained type (`USCorePatientProfile.identifier`, an
  `Identifier` with `system` required), only for this profile.
- **Slicing**: each slice gets a pattern built from the discriminators (`value`/`pattern` on a
  path, `url` for extensions, `type` for resources) and, when it constrains its items, a type of
  its own (`…component:systolic`). A slice whose discriminator is `$this` with no fixed value is
  matched by its binding's value set (`Condition.category:us-core`). The codec puts each item in
  the first slice it matches, checks each slice's `min`/`max` and its items against the slice
  type, and fails unmatched items of a closed slicing. Items stay in their element (no
  properties, unlike `@FhirSlice`).
- **Extension definitions** are profiles on `Extension`: `url` fixed, `value[x]` narrowed or
  forbidden (`max 0`), the parts of a complex one as slices of `extension`.
- `max: 0` is checked: an element a profile forbids fails when present.
- `meta.profile` with several loaded profiles: decoded with the first, checked against the
  others. Issues found twice (by the type and by a slice) are reported once.

Results with `hl7.fhir.us.core#6.1.0` (59 StructureDefinitions, 36 ValueSets, 183 examples):

| Measure | Result |
| ------- | ------ |
| Loaded | 49 profiles, 10 extension definitions |
| Value sets of US Core's required bindings | 56 listed; 14 not: they include VSAC value sets (`us.nlm.vsac`, not loaded), filters, or code systems not at hand (UCUM); those bindings are not checked. (Counted since "Selective reading"; before, the report counted every value set of the package: 11 listed, 25 not.) |
| Warnings | 3 slicings by a value set whose codes are not known, not checked |
| Examples | 183 of 183 decode; 174 name a loaded profile and are checked against it |
| Mutations caught | `Patient.identifier.system` removed; `us-core-race` without `text`; blood pressure without the systolic component; a component quantity without its code; a problem `Condition` without the `us-core` category; `CarePlan.text.status` outside its required value set |
| Time | read the folder 19 ms, load 12 ms; blood pressure example: decode 4.6 µs with the profile, 2.5 µs without |

Found while testing and fixed: a discriminator path through a repeating element
(`coding.code`, `coding` an array) did not match; slices of another element with an id of the
same length (`Observation.category`, `Observation.value[x]`) were taken as its slices.

Not done:

- Dependencies: see "Dependencies" below.
- Value sets of core bindings that are not required are not in the model (the generator writes
  required ones only): `medicationrequest-category` slicing is not checked.
- Discriminators `profile` and `exists`; re-slicing (`slice/reslice`); a primitive sliced by value.
- Invariants (FHIRPath) of profiles.
- Profiles without a snapshot (differential only) are skipped with a warning.

### Dependencies (2026-11-20)

A package's dependencies are loaded before it, so its value sets can use their code systems and
value sets (`us-core-birthsex` is built from VSAC value sets). Code:
`packages/core/src/package/fhir-package-cache.ts`, `tgz.ts`.

```ts
const cache = new FhirPackageCache({ download: true }); // ~/.fhir/packages, packages.fhir.org
const { packages, skipped, conflicts } = await cache.resolve('hl7.fhir.us.core', '6.1.0');
const fhir = new FhirContext(r4Model, { packages });  // dependencies first, US Core last
```

| Part | Behaviour |
| ---- | --------- |
| Cache | `<name>#<version>/package` folders, by default `~/.fhir/packages`: the folder HAPI, Firely and the IG Publisher share, so packages they downloaded are used |
| Download | Only with `download: true`. The `.tgz` from the registry (`packages.fhir.org` by default, or `registry`) is read in memory (`readTgz`: gzip and ustar, pax and GNU long names) and its files written to a temporary folder, then moved; a name with `../` is not written |
| Order | Depth-first, each package after its dependencies; a package asked in two versions uses the first one met and is listed in `conflicts` |
| Skipped | The examples and expansions packages of FHIR versions. The core package is loaded as data since "Core package profiles" (before, it was skipped too). `skip` changes it |
| Versions | Exact only (`1.0.0`, `1.0.0-ballot`); ranges and `current` are refused |
| Across packages | The model keeps the codes of the complete code systems and the value sets of loaded packages; a later package's value sets resolve with them |
| `FhirPackage.fromTgz()` | Reads a package from a `.tgz` without the cache |

Results with US Core 6.1.0 and its 8 dependencies (`hl7.terminology.r4`, `hl7.fhir.uv.extensions.r4`,
`hl7.fhir.uv.bulkdata`, `hl7.fhir.uv.smart-app-launch`, `us.nlm.vsac`, `hl7.fhir.uv.sdc`,
`us.cdc.phinvads`, `ihe.formatcode.fhir`):

| Measure | Result |
| ------- | ------ |
| Download (all 9) | about 8 s; 500 MB on disk, of which VSAC 268 MB, PHIN VADS 116 MB |
| Read from the cache | 2.1 s; 18,800 value sets, 653 StructureDefinitions (20 ms since "Selective reading") |
| Load into the model | 0.34 s; 49 + 26 + 3 profiles, 573 extension definitions, 17,300 value sets listed (0.24 s since) |
| Memory | about 590 MB while the packages are read; about 107 MB kept by the model once they are released (60 MB and 56 MB since) |
| US Core | value sets of its required bindings: 63 listed, 7 not (56 and 14 without dependencies); warnings 2 (3 without) |
| US Core examples | 183 of 183 decode |
| `us-core-birthsex` `valueCode: 'X'` | now fails (passed without VSAC) |

Found while testing and fixed: the cache kept every package it had read for as long as it lived;
it now keeps only reads in progress.

Not done:

- ~~Reading is eager~~: done, see "Selective reading".
- ~~The core package's own profiles, extensions and value sets~~: done, see "Core package profiles".
- Version ranges, `current`, package scopes other than the FHIR registry, authentication.

### Package names (2026-11-20)

Decided: the npm scope `@fhirjs` (taken by the user on npm), one package per FHIR version:

| Package | Folder | Content |
| ------- | ------ | ------- |
| `@fhirjs/core` | `packages/core` | decorators, model, codec, profiles, package loading |
| `@fhirjs/r4` | `packages/r4` | generated R4 classes, value set codes, `r4Model` (was `fhir-models/r4`) |
| `@fhirjs/r5` | `packages/r5` | the same for R5 (5.0.0); see "R5" |
| `@fhirjs/r4b` | `packages/r4b` | the same for R4B (4.3.0); see "R4B" |
| `@fhirjs/fhirpath` | `packages/fhirpath` | FHIRPath: parser, compiler, functions; no dependency (see "FHIRPath") |
| `@fhirjs/client` | `packages/client` | REST client only; see "Client" |
| `@fhirjs/server` | later | FHIR server, a package of its own (decided 2026-11-20) |

`fhir`, `fhir-models` and other unscoped names were taken or would split the packages across
names. The generator writes `packages/<version>/src`.

### Generated sources in the repository (2026-11-20)

Decided: the generated sources (`packages/r4/src`, 193 files, 2 MB) are kept in the repository,
as hl7v2 keeps `data/hl7-data.js`. A build needs no download of the HL7 packages, and a change of
the generator shows in the diff of what it writes. `.gitattributes` marks them
`linguist-generated`, so GitHub folds them in reviews. The HL7 packages themselves
(`support/fhir-packages/`) and `build/` stay out. After a change to the generator:
`node support/build-models.mts`, then commit what it wrote.

### Selective reading (2026-11-20)

A package is read through its `.index.json` (every published package has one: file, resource type,
id, url of each resource). Reading a package reads the index; its StructureDefinitions are parsed
when it is loaded (profiles need them); a value set or code system is parsed the first time a
binding, a slice or another value set asks for it by URL. Code: `FhirPackage` (`entriesOf`,
`findResource`, `parsedCount`), `FhirModel.getValueSet()` (lists a package's value set on first
use, with the value sets and code systems it includes, from the package loaded last first);
`resolveValueSet()`.

The package report now counts the value sets of the package's own required bindings (listed at
load, as they are the ones its profiles check), not every value set it carries.

US Core 6.1.0 with its 8 dependencies:

| Measure | Read everything | Selective |
| ------- | --------------- | --------- |
| Read the packages from the cache | 2,138 ms | 20 ms |
| Load into the model | 339 ms | 242 ms |
| Heap at its highest | about 670 MB | 60 MB |
| Kept by the model | about 107 MB | 56 MB (the packages stay referenced, for value sets asked for later) |
| VSAC value sets parsed | 14,323 | 9 |
| Resources parsed in all 9 packages | about 20,700 (18,823 value sets, 1,184 code systems, 653 StructureDefinitions) | 751, after decoding the 183 examples |
| US Core examples | 183 of 183 | 183 of 183 (37 ms) |
| `us-core-birthsex` `valueCode: 'X'` | fails | fails |

A package without `.index.json` is still read whole. Tests: the `.index.json` path (a name with a
folder or `../` in the index is skipped), `parsedCount` of VSAC below 20 after loading US Core.

### Core package profiles (2026-11-20)

The core package (`hl7.fhir.r4.core`) loads like any other package, on top of the generated model:
its profiles (`vitalsigns`, `bp`, `bmi` ...), extension definitions (`patient-birthPlace` ...)
and value sets become available. `FhirPackageCache.resolve()` now keeps it (it skips only the
examples and expansions packages), so an IG's dependency on it brings it in.

```ts
const fhir = new FhirContext(r4Model, { packages: [FhirPackage.fromDirectory('…/hl7.fhir.r4.core#4.0.1/package')] });
```

- **Types the model has are not read**: an index entry whose `id` is its `type` (`Patient`,
  `string`) is skipped without opening the file. Loading reads about 500 of the 4,581 files.
- **Extensions by their definition.** An extension whose `url` names a definition the model has (a
  package's, or a `@FhirExtensionType` class) is checked against it, with or without a profile on
  the resource: `patient-birthPlace` with `valueString` fails (its value is an `Address`).
  `extensions: false` turns it off. When writing, a definition class with extension or slice
  properties takes only its own instances; an entry already in JSON form is checked as a plain
  `Extension`.
- **Fixed while loading the core package**: R4 writes some System types as `_code` with a
  json-type extension, without `code` (the `structuredefinition-xml-type` extensions crashed the
  builder); a discriminator path through a sliced element (`code.coding.code` in `bp`, where
  `coding` is sliced too) now finds `component:SystolicBP.code.coding:SBPCode.code`.

| Measure | Result |
| ------- | ------ |
| Loaded from `hl7.fhir.r4.core` | 46 profiles, 396 extension definitions; read 5 ms, load 96 ms, 27 MB kept |
| Warnings | 2 example profiles without a snapshot; `lipidprofile` slices by `resolve().code` (a FHIRPath function: not supported) |
| R4 examples | 1,943 name a core profile; every valid one decodes against its profiles and extension definitions (5,296; the same 13 invalid as without the package) |
| Mutations caught | blood pressure without the vital-signs category (`vitalsigns`); without the systolic component (`bp`); `patient-birthPlace` with a string value |
| US Core with dependencies | value sets of its required bindings: 68 listed, 2 not (63 / 7 without the core package); no warning (2 without: the `MedicationRequest` and `ServiceRequest` category slicings by core value sets are now checked) |
| Speed | the whole examples package decodes in 284 ms with the core package, 262 ms without; the BMI example 3.3 µs against `vitalsigns`, 2.4 µs without |

R5's core package has 63 profiles and a single extension definition (R5's extensions are in
`hl7.fhir.uv.extensions.r5`); it loads the same way but has not been tested yet.

### FHIRPath (2026-11-20)

Decided: a FHIRPath of our own, in its own package, with a hand-written lexer and parser.
fhirpath.js (tried first, see the comparison below) brings its own model files, which would
drift from ours (R4B, the generator's corrections, profiles, types of loaded packages), old
dependencies (`antlr4` 4.9, `date-fns` 1.x), an async-only `resolve()`, and costs about 120 µs
for the invariants of one Patient.

`@fhirjs/fhirpath` (`packages/fhirpath`, about 3,600 lines, 105 KB built, no dependency; sizes
since "FHIRPath test suite"):

| Part | What |
| ---- | ---- |
| `lexer.ts`, `parser.ts`, `ast.ts` | A Pratt parser with the specification's precedence; literals (strings with escapes, decimals keeping their text, dates and times, quantities with UCUM or calendar units, delimited names); errors with their position |
| `evaluate.ts` | The syntax tree compiled to functions of a context ($this, $index, $total, %variables); navigation with primitive extensions (`_given`) and choices (`deceased`); three-valued logic; =, ~, comparisons at the precision of dates; arithmetic, date + duration (month ends kept: Jan 31 + 1 month is Feb 29) |
| `functions.ts` | Existence, filtering, subsetting, combining, conversion (`toX`, `convertsToX`), string (with 2.1's `trim`, `split`, `join`, `encode`/`decode`, `escape`/`unescape`), math, `sort`, `type`, tree navigation, `trace`, `aggregate`, and FHIR's `extension`, `hasExtension`, `hasValue`, `resolve` (contained, Bundle entries, or the caller's resolver; synchronous), `memberOf` (the caller's), `conformsTo`, `htmlChecks`, `lowBoundary`/`highBoundary` (exact, on the decimal's text), `comparable` |
| `ucum.ts` | The part of UCUM quantities need: prefixes, products, quotients, powers and the common atoms, so `1000 'mg' = 1 'g'` |
| `model.ts` | `FhirPathModel`: the children of a type, its hierarchy, its primitives. Without one, JSON keys |
| `fhirpath.ts` | `new FhirPath({ model, resolve, memberOf, conformsTo, trace, lenient })`, `compile(expr)` (cached), `evaluate(input, expr, { type, resource, rootResource, vars })`, `test()` for invariants |

`@fhirjs/core` gives the model: `fhirPathModelOf(model)` reads the same `FhirModel` the codec uses,
so FHIRPath sees generated classes, profiles and loaded packages alike, with no second model.

```ts
const fp = new FhirPath({ model: fhirPathModelOf(r4Model) });
fp.evaluate(patient, "name.where(use = 'official').given.first()");
fp.compile(constraint.expression).test(contact, { type: 'Patient.contact', resource: patient });
```

Typing is strict by default, as the specification and its test suite have it: a FHIR `boolean` is
not a `System.Boolean` (`Patient.active.is(Boolean)` is false), `as` on more than one item is an
error, an unknown type name is an error. `lenient: true` relaxes the first two for invariants
written against the older reading (R4's que-7 asks `answer is Boolean`, R5 corrected it to
`boolean`; R4's dom-3 applies `as` to a collection); `validate()` runs with it. Always accepted:
`"double-quoted"` strings (R4's eld-11).

Results:

| Measure | Result |
| ------- | ------ |
| R4 and R5 invariants and search parameter expressions parsed | 2,214 of 2,214 |
| Every R4 invariant on every node of the 5,296 valid R4 examples | 1,999,892 evaluations |
| Same outcome as fhirpath.js | 1,903,909; 1 different (que-7 above); fhirpath.js fails on 95,982 (regexes of eld-16/19/20 in JavaScript's `u` mode, `resolve()` without async), which this engine evaluates |
| Errors in this engine | 0 |
| Error-level invariants false | 8, all real: `sdf-4` (example logical models without `baseDefinition`), `sdf-19` (R4 extension definitions with `_code` and no `code`), `bdl-7` (an example Bundle with duplicate `fullUrl`s); fhirpath.js gives the same |
| Time for those evaluations | 5.8 s (fhirpath.js: 11.3 s) |

Found while comparing and fixed: string functions on a primitive with only extensions now give
nothing instead of an error (`sdf-19`).

Not done:

- ~~The invariants are not run by `FhirContext`; `memberOf` not connected~~: done, see "validate()".
- ~~HL7's official FHIRPath test suite has not been run~~: done, see "FHIRPath test suite".
- R5's invariants not compared.
- ~~UCUM conversion; `conformsTo()`; the decimal text kept by the codec~~: done, see "FHIRPath
  test suite". `htmlChecks()` checks the `<div>` and the XHTML namespace only.

### FHIRPath test suite (2026-11-20)

HL7's FHIRPath test suite (`FHIR/fhir-test-cases`, `r4/fhirpath/tests-fhir-r4.xml` at commit
`2cfcc672`, 1,191 cases) runs as a mocha test: `packages/r4/test/fhirpath-suite.spec.ts`.
`support/fetch-packages.mts` downloads it with its inputs (into
`fhirpath-tests@<commit>/r4/`). Most inputs exist only as XML, so the test reads them with a
small FHIR XML reader (`packages/core/test/_support/fhir-xml.ts`, test-only) that uses
the R4 model for what repeats, what is a primitive and the JSON kind of each; decimals keep their
text (`9.5e2`), as the codec keeps it for JSON.

| Measure | Result |
| ------- | ------ |
| Cases | 1,191; every input read |
| Out of scope | 132: `documentFunctions` (103, `mode="custom"`: `section()`, `sameSubject()` ... of the Java reference engine only), `isSemanticChecks` (29, `mode="semantic"`: errors of a static type checker) |
| In scope | 1,038; 1,027 pass (1,026 since "FHIRPath test suite (R5)", see there) |
| Known failures (11, listed by name in the test) | 6 expect a static type error (`name.given1`, `Observation.valueQuantity` ...): this engine had no static type checker (they pass since "FHIRPath static checks"). 5 boundary results that differ from the rule the suite's other boundary cases follow (`0.0034.highBoundary(1)` is `0.1` by the ceiling rule, the suite has `0.0`; hour precision with seconds filled but minutes not) |

The test fails when a case outside the list fails, and when a listed one starts to pass.

What the suite brought in (before it: 773 of 1,164 run passed):

- **Functions**: `convertsToX` and `toQuantity`/`toDate`/`toDateTime`/`toTime`, `trim`, `split`,
  `join`, `encode`/`decode` (base64, urlbase64, hex), `escape`/`unescape` (html, json), `sort`
  (keys with `-` for descending, empty first), `type()` (`namespace`, `name`), `conformsTo()` (a
  core StructureDefinition: being of its type; a profile: the caller's `conformsTo`; unknown: an
  error).
- **Strict typing**, with `lenient` for the validator (see "FHIRPath"). `is()` follows the
  primitive hierarchy (`code` is a `string`), which the generated classes do not show; `as()` and
  `ofType()` match a primitive's own type only, as the suite has it.
- **Quantities**: UCUM units convert for =, <, +, −, ×, ÷ (`ucum.ts`); different dimensions and a
  unit against no unit compare as empty; equivalence lets `1 year` be `1 'a'`, equality does not.
  `abs()` and the like keep the unit.
- **Decimals**: results keep the places of their operands (`1.0 + 2.00` is `3.00`);
  `lowBoundary`/`highBoundary` work on the text in exact integers (`1.587.highBoundary(8)` is
  `1.58750000`, `9.5e2` has the uncertainty 5). FHIRPath reads the decimal text `@fhirjs/core`
  keeps beside a value (`Symbol.for('fhir.decimalText')`), so JSON's `1.50` keeps its places.
- **Dates and times**: `@T10:30` literals; a time with an offset on one side only does not
  compare; `+ 1 month` clamps to the month's end and keeps milliseconds; `'a'` and `'mo'` are not
  calendar durations.
- **Smaller**: `skip({})`, `replace()` with an empty pattern, `iif()` with a non-Boolean
  criterion or on a collection (an error).

The fhirpath.js comparison over the R4 examples is unchanged (it runs lenient, as `validate()`).

Not done:

- A static type checker (the 6 cases above and the `isSemanticChecks` group).
- ~~The R5 suite~~: done, see "FHIRPath test suite (R5)".

### FHIRPath test suite (R5) (2026-11-20)

The R5 suite (`r5/fhirpath/tests-fhir-r5.xml`, same commit, 1,347 cases) runs with the R5 model:
`packages/r5/test/fhirpath-suite.spec.ts`. Both versions share one driver
(`describeFhirPathSuite()` in `packages/core/test/_support/fhirpath-suite.ts`), the out-of-scope
groups and the known failures; each suite's inputs are in `fhirpath-tests@<commit>/<r4|r5>/`.

| Measure | R4 | R5 |
| ------- | -- | -- |
| Cases | 1,191 | 1,347 |
| Out of scope | 132 (`documentFunctions` 103, `isSemanticChecks` 29) | 159 (`documentFunctions` 115, `isSemanticChecks` 38, `TerminologyTests` 3: `%terminologies` needs a terminology server; 3 cases on `ccda.xml`, a CDA document, a logical model the FHIR model does not have) |
| In scope, passing | 1,026 of 1,038 | 1,177 of 1,188 |
| Known failures | the 11 shared ones, and `testPlusDate19` | the 11 shared ones (see "FHIRPath test suite") |

What R5's cases brought in:

- **`defineVariable(name[, value])`** (FHIRPath 2.0): the variable holds for the rest of the
  invocation chain (`name.defineVariable('n').select(%n.given)`), not for other operands (`|`,
  `and`) or outside the argument it was made in. The value is evaluated on the whole input.
  Redefining a variable, or naming a system one (`%resource`, `%ucum`), is an error. The scope
  travels on the result array of each step (`SCOPE` in `evaluate.ts`), so the functions do not
  change.
- **`distinct()` keeps the last of each repeat** (`'a' | 'b' | 'a'` gives `b, a`), as R5's suite
  has it; with dates of different precisions it gives nothing, and `isDistinct()` too.
- **Seconds with a fraction** added to a dateTime with milliseconds keep it (`+ 0.1 's'` gives
  `.100`). R4's suite expects `.000` for the same case (`testPlusDate19`): its only new known
  failure.
- **Lenient navigation by a choice's JSON key** (`Observation.valueQuantity`), for the suite's
  `mode="lenient/..."` cases; strict mode leaves it empty, as before.
- **`htmlChecks()`** on a fragment: only the XHTML elements FHIR narratives allow, no `on...`
  attributes (`<button>` fails); a root `<div>` still needs the XHTML namespace.
- **Comparisons** with a primitive that has only extensions give nothing instead of an error.
- The runner reads `ordered="false"` (outputs in any order).

Not done:

- The terminology functions (`%terminologies.expand()`, `validateVS()`, `translate()`).
- A static type checker, as for R4.

### validate() (2026-11-20)

`FhirContext.validate(input, type?, options?)` checks a resource (JSON text, a JSON object or an
instance) against everything the model knows and returns the issues, without throwing. Code:
`packages/core/src/fhir-context.ts` (`validate`), `validation/fhir-validator.ts` (`FhirInvariants`).

```ts
const r = fhir.validate(json);             // or text, or an instance; { profile, invariants, warnings }
r.valid;                                   // no error or fatal issue
r.issues;                                  // [{ severity, code, expression: 'Patient.contact[0]', diagnostics: 'pat-1: ...' }]
r.value;                                   // the instance read (from JSON)
r.outcome();                               // an OperationOutcome
```

1. The codec: structure, cardinality, required bindings, the profiles `meta.profile` names (and
   those given as `profile`), extensions by their definition. Its issues are collected, not thrown.
2. The invariants: the resource's JSON form is walked with the model's types; on each node, the
   constraints of its type and its bases, and of the profiles it is checked against (a profile's
   chain includes its base, an invariant met twice on a node is run once); on each element, its
   own constraints. Contained resources get `%rootResource` = the container; Bundle entries are
   their own root. An invariant that is false gives an `invariant` issue of its severity; one that
   cannot be evaluated gives a warning (`exception`), not an error.
3. Profiles read from packages now carry their invariants: a constraint of the snapshot with no
   `source`, or the profile's own, belongs to the profile (US Core: 29). On a primitive element it
   stays with the element; on a complex one, it is the invariant of the constrained type.
4. `memberOf()` in FHIRPath answers from the model's value sets (codes, Codings,
   CodeableConcepts); a value set whose codes are not known gives nothing.

`dom-6` (a resource should have narrative) is not run on contained resources, which have no
narrative of their own.

| Measure | Result |
| ------- | ------ |
| R4 examples | 5,309 in 7.1 s; 21 invalid: the 13 the codec finds, and `sdf-4` (4), `sdf-19` (3), `bdl-7` (1) |
| US Core 6.1.0 examples, with its dependencies | 183 valid, with US Core's own invariants; a patient with neither `family` nor `given` fails `us-core-6` |
| Patient example | decode 10 µs, validate 42 µs |
| Observation / Bundle examples | validate 19 / 31 µs |

Not done: best-practice invariants are plain warnings (the `elementdefinition-bestpractice`
extension is not read); extensible and preferred bindings are not checked; no terminology server
for value sets the model cannot list.

### R5 (2026-11-20)

`@fhirjs/r5` (`packages/r5`) is generated from `hl7.fhir.r5.core#5.0.0` by the same generator
(`node support/build-models.mts --version=R5`; `pnpm generate` writes both versions). No change
to `@fhirjs/core` was needed.

| Measure | R4 | R5 |
| ------- | -- | -- |
| Classes | 682 (148 resources, 41 data types, 473 backbones, 20 primitives) | 861 (162 resources, 48 data types, 630 backbones, 21 primitives) |
| Concrete resources | 146 | 158 |
| Required bindings as string unions | 245 types | 282 types |
| Value sets listed for the codec | 220 | 245 |
| `@FhirElement` in the generated code | 5,534 | 7,097 |
| Generated source / JavaScript / gzip | 2.0 MB / 1.4 MB / 143 KB | 2.5 MB / 1.8 MB / 188 KB |
| Import of all classes, build every type | 73-89 ms, 6 ms | 83-88 ms, 6 ms |
| Elements compared with the core snapshots | 7,406, no difference | 9,261, no difference but the one below |
| Examples, round trip | 5,296 of 5,309 (13 invalid in the package) | 2,822 of 2,822 |

What R5 needed in the generator:

- **`Base` at the root.** `Element` and `Resource` derive from `Base`, data types from `DataType`
  or `BackboneType`, primitives from `PrimitiveType`. The generated `Resource` now calls
  `super()` when it has a base.
- **`integer64`** is a JSON string in R5 (a number would lose digits); the generator gives it
  `json: 'string'`, so the codec takes and writes a string and the TypeScript type is `string`.
- **A binding name that is not an identifier** made an empty type name; such a binding is named
  after its value set.
- **Inherited elements.** `MetadataResource` has `DomainResource` as its base but takes
  `CanonicalResource`'s elements (an interface in R5): their `base.path` names a type the class
  does not extend. An element is now inherited only when its `base.path` starts with a type the
  class derives from: the `baseDefinition` chain of a type, or `BackboneElement` (or `Element`)
  and its chain for a backbone. A first version took the resource's chain for its backbones too,
  so every backbone redeclared `id`, `extension` and `modifierExtension`; the tests passed (the
  definitions are the same), the count of `@FhirElement` in R4 showed it. With the fix R4 has its
  5,534 again.

A difference in the R5 core package itself: `Element.id` is `string` in the `Element`
definition, but `id` in the snapshots of the data types (`Address.id`) and `string` again in
backbone elements. The model keeps `Element`'s (`string`; both are JSON strings, `id` only adds a
64-character pattern); the snapshot test lists `X.id` as a known difference.

Not done for R5: profiles and IGs for R5 (the loader is version-neutral, but no R5 IG has been
tested), and the examples package is read only for the round trip.

### R4B (2026-11-20)

`@fhirjs/r4b` (`packages/r4b`) is generated from `hl7.fhir.r4b.core#4.3.0` by the same generator
(`node support/build-models.mts --version=R4B`; `pnpm generate` writes all three versions). R4B
keeps R4's base types (data types derive from `Element`, backbones from `BackboneElement`) and
takes some of R5's resources and types: `CodeableReference`, `SubscriptionTopic`,
`SubscriptionStatus`, `Citation`, `EvidenceReport`, `NutritionProduct`, and the new medication
definition resources (`MedicinalProductDefinition`, `PackagedProductDefinition`,
`SubstanceDefinition` ... in place of R4's `MedicinalProduct*` and `Substance*` ones).

| Measure | R4B |
| ------- | --- |
| Classes | 702 (143 resources, 43 data types, 496 backbones, 20 primitives) |
| Concrete resources | 141 |
| Required bindings as string unions | 252 types |
| Value sets listed for the codec | 227 |
| `@FhirElement` in the generated code | 5,652 |
| Generated source | 190 files, 2.0 MB |
| Elements compared with the core snapshots | 7,519, no difference but `X.id` (as in R5) |
| Examples, round trip | 2,826 of 2,840; the 14 others invalid in the package (13 miss a required element, 1 has an id over 64 characters) |
| `validate()` on every example | invariant errors, all real (checked by hand): `cmd-1` 4 (narrower mappings without a comment), `csd-1` 2 (a repeated code), `que-2` 1 (repeated linkIds), `sdf-4` 4, `sdf-10` 3 (bindings with neither a value set nor a description) |
| FHIRPath suite (`r4b/fhirpath/tests-fhir-r4b.xml`, 1,191 cases) | 1,024 of 1,036 in scope pass; the known failures are R4's 12 |

What R4B needed:

- **`Element.id`.** R4B alone types it `id` (R4 and R5: `string`), and its own data does not fit:
  `ElementDefinition.id` values such as `Measure.subject[x]` failed the `id` pattern in 561
  examples. The generator keeps `string` for `Element.id`, as in the other versions; R4 and R5
  are generated unchanged.
- **`base64Binary` in one pass.** Its regex, `(\s*([0-9a-zA-Z\+/=]){4}\s*)+`, overflowed the stack on
  the 4.6 MB value of `Library-FHIR-ModelInfo.json`. The codec now checks the same rule with a
  loop (`isBase64()` in `primitive-codec.ts`, tested against the regex); this applies to every
  version.
- **`sdf-24` cannot be evaluated** in R4B: it calls `$this.length()` on an `ElementDefinition`
  (R5 corrected it to `$this.path.length()`). `validate()` reports it as a warning
  (`exception`) on 6 examples; the test lists it.

Tests: `packages/r4b/test/r4b.spec.ts` (model, snapshots, codec, examples),
`validate.spec.ts`, `fhirpath-suite.spec.ts`. The pre-R5 suites (R4, R4B) share one more known
failure, `testPlusDate19` (`KNOWN_BEFORE_R5` in the suite driver).

Not done for R4B: profiles and IGs for R4B (no R4B IG tested), and the fhirpath.js comparison
over its examples (fhirpath.js has no R4B model).

### FHIRPath static checks (2026-11-20)

`check()` checks an expression against the type of its input, without data. Code:
`packages/fhirpath/src/check.ts`; it uses the same `FhirPathModel` as evaluation (one optional
method more, `isAbstract`). Evaluation does not change: checking is a separate, opt-in step.

```ts
fp.check('name.given1', { type: 'Patient' });
// [{ message: 'HumanName has no element "given1"', start: 0, end: 11 }]
fp.check('$this.toString()', { type: ['Period', 'Timing'] }); // a context of several types
fp.compile(expr).typeOf({ type: 'Observation' });            // the types it infers: ['dateTime', 'Period', ...]
```

| It finds | Example |
| -------- | ------- |
| Elements no type of the collection has | `name.given1`; `Observation.valueQuantity` (strict; lenient takes JSON keys); `(value as Period).unit` |
| A type name at the start that is neither the input's type nor one of its elements | `Encounter.name` on a Patient |
| Unknown type names, functions, variables; wrong argument counts | `ofType(Nme)`, `%foo` |
| Functions given what they do not take: Strings, primitives to convert, numbers | `Period.toString()`, `name.length()` |
| Order from an unordered collection | `children().first()`, `descendants()[0]` |
| A non-Boolean `iif()` criterion; a number added to a date | `iif(1 \| 2, ...)`, `@1974-12-25 + 7` |
| `defineVariable()` misuse | a variable used outside its chain, defined twice, or named like a system one (`%context`) |

How it decides:

- **A collection's type is a set of types** (`Observation.effective`: dateTime, Period, Timing,
  instant). A check fails only when no type of the set fits, so a choice is not an error for
  the types it may have.
- **Type guards narrow `$this`** for the operand they guard, as the R5 suite specifies:
  `A implies B`, `A and B`, `iif(A, B, ..)` check B with the types A lets through; `A or B`,
  `iif(A, .., B)` with those it excludes. A can be `$this is T`, `$this.is(T)`, `.not()`, and
  `and`/`or` of those. An operand no type reaches is not checked (`$this is dateTime implies ...`
  on a Period).
- **Abstract types are open**: `Bundle.entry.resource` is a `Resource`, which may be any
  resource, so its elements are not checked.
- **A primitive's `value`** (`mustHaveValue.value`) is its value as a System type, as FHIR's
  primitive definitions have it. Evaluation did not read it (it gave nothing, so R5's eld-28
  always held); it does now.

Tests:

- **The suites check every case**: an `invalid="semantic"` case passes only if `check()` reports
  it, and every other case must check clean (no false positive in about 3,300 cases). The runner reads
  `context`, `contextType` and `skipStaticCheck`. `isSemanticChecks` is in scope now; the 6
  "static type checking" known failures pass.
- **Every invariant of the specification type-checks**, strict and lenient
  (`describeInvariantCheck()` in `packages/core/test/_support/invariant-check.ts`), each against
  its context: a type's against the type, an element's against the types the element may have.
  R5: 383 of 383 clean. The others list errors of the specification itself: `cid-0` (R4, R4B) and
  `cnl-0` (R4B `Evidence`, `EvidenceReport`) test a `name` those resources do not have, so they
  never fail; R4B's `sdf-24` and `sdf-25` take the `length()` of an `ElementDefinition` (R5
  corrected it to `$this.path`).
- `packages/r4/test/fhirpath.spec.ts`: the API, with positions.

| Suite | Before | Now |
| ----- | ------ | --- |
| R4 | 1,026 of 1,038 | 1,070 of 1,076 (`isSemanticChecks` in scope); known: the 5 boundary cases, `testPlusDate19` |
| R4B | 1,024 of 1,036 | 1,068 of 1,074; known: the same |
| R5 | 1,177 of 1,188 | 1,221 of 1,226; known: the 5 boundary cases |

Not done:

- `validate()` does not run `check()`: the invariants are fixed, so the test above is enough;
  profiles of loaded packages bring their own invariants, which could be checked when loaded.
- Types of most function results that are not listed (`aggregate()`, `resolve()`, `getValue()`)
  are "any": nothing is checked after them.
- Operators are checked only for date + number; the operands of `=`, `<` and arithmetic are not.

### Client (2026-11-20)

`@fhirjs/client` (`packages/client`): a client of a FHIR server's REST API. It depends on
`@fhirjs/core` only; the FHIR version is the `FhirContext` it is given, so one client serves R4,
R4B and R5.

```ts
const client = new FhirClient({ baseUrl: 'https://server/fhir', fhir: new FhirContext(r4Model) });

const patient = await client.read(Patient, '123');          // a Patient instance, checked by the codec
patient.active = true;
await client.update(patient, { ifMatch: true });            // If-Match: W/"<meta.versionId>"
const created = await client.create(new Patient({ name: [{ family: 'Kaya' }] }));

const found = await client.search(Observation, { subject: 'Patient/123', date: ['ge2026-01-01', 'lt2026-02-01'], _count: 50 });
found.resources; found.included; found.total;
for await (const page of found.pages()) ...;                // or await found.all(limit)

await client.operation<Parameters>('$validate', { type: Patient, input: parameters });
await client.transaction(bundle);
```

| Interaction | Method |
| ----------- | ------ |
| read, vread | `read(type, id)`, `vread(type, id, vid)`: `type` is a class or a name; the answer must be of that type |
| create | `create(resource, { ifNoneExist })`: `Prefer: return=representation`; a server that answers without a body is read back from its `Location` |
| update | `update(resource, { ifMatch })`: the version given, or `true` for the resource's `meta.versionId` |
| patch, delete | `patch(type, id, jsonPatch)`, `delete(type, id)` |
| search, history | `search(type, params, { method: 'POST' })`, `history(type?, id?)`: a `FhirSearchResult` |
| capabilities, operation | `capabilities()`, `operation(name, { type, id, input \| params })` |
| transaction, batch | `transaction(bundle)`, `batch(bundle)`: the Bundle's `type` must say so |
| anything else | `request(method, path, { body })`: the raw `Response`, through the interceptors |

Decisions in it, to be discussed:

- **Bodies through the codec, both ways.** What is sent is checked first: an invalid resource
  (a code outside a required binding) fails before any request. What comes back is decoded into
  the model's classes. Decimals keep their text both ways (`1.50`). `decode: { unknownElements:
  'keep' }` reads servers that send elements the model does not know.
- **Search parameters** are an object. A value list repeats the parameter (AND:
  `birthdate: ['ge1970', 'lt1980']`). OR is FHIR's comma in one value (`'smith,jones'`).
  Modifiers and chains go in the key (`'name:exact'`). A `Date` is written as its instant.
  `URLSearchParams` works too.
- **Errors**: a status other than 2xx throws `FhirClientError` with `status`, the server's
  `OperationOutcome` (when it sent one) and its `diagnostics`; an HTML error page gives the status
  alone.
- **Transport**: the global `fetch` (Node 22 and browsers), or the one given. `interceptors`
  have the shape of `@opra/client`'s (`(request, next) => next(request)`): for a token, retries,
  logging. Promises, not observables: one request, one answer.
- **Safety**: ids and type names are checked before they become a path (`../metadata` is
  refused). A `next` link is followed only under the base URL, so headers such as a token are not
  sent to another host.

Tests: 23, over HTTP against `TestFhirServer` (in-memory, on 127.0.0.1, records every request).
They cover:

- every interaction, and conditional create;
- If-Match with a stale version (412);
- the Location fallback of a server that answers without a body;
- paging, `_include` and POST `_search`;
- interceptors, path checks, a non-FHIR error page and lenient decoding;
- decimals both ways.

Not done:

- ~~Authentication helpers~~: `bearerToken()`, see below; SMART on FHIR: see "SMART on FHIR".
- ~~Conditional update, delete and patch; `_summary`, `_elements`~~: done, see below.
- XML; `Prefer: respond-async` (bulk data); subscriptions.
- A test against a real server (HAPI's public test server): the in-memory one is not a FHIR
  implementation.

### Client: conditional interactions, partial reads, tokens (2026-11-20)

```ts
await client.update(patient, { where: { identifier: 'urn:oid:1.2|42' } }); // PUT Patient?identifier=...
await client.patch(Patient, { identifier: '42' }, [{ op: 'replace', path: '/active', value: true }]);
await client.delete(Patient, { identifier: '42' });                       // DELETE Patient?identifier=42

const part = await client.read(Observation, 'o1', { elements: ['valueQuantity'] }); // _elements
const page = await client.search(Patient, { name: 'smith' }, { summary: 'true' });  // _summary

new FhirClient({ baseUrl, fhir, interceptors: [bearerToken(refresh => tokens.get(refresh))] });
```

- **Conditional interactions**: `update(resource, { where })`, and `patch` and `delete` take a
  search in place of an id: `[type]?search`. What the server does with no match, one match or
  several (create, update, 412) is its own. A search with no parameters is refused before it is
  sent: it would match every resource of the type (a conditional delete of all of them).
- **Partial resources**: `summary` and `elements` (on `read`, `vread`, `search`) ask for a part.
  The server tags what it leaves incomplete `SUBSETTED`. A resource (or a Bundle entry) with that
  tag is decoded without its required elements (the codec's `partial`), whether asked for or
  sent so by the server. Any other resource is still checked whole. `update()` refuses a
  SUBSETTED resource, as the specification says a client must: writing it back would erase what
  was left out.
- **`bearerToken(provider)`**, an interceptor:
  - It sends `Authorization: Bearer`.
  - On a 401 it asks the provider for a new token (`refresh: true`) once and sends the request
    again, with its body (kept by `Request.clone()`).
  - Requests refused together share one refresh, and the new token is kept for the next ones.
  - A second 401 is the caller's error.

Tests: 32 for the client (9 more), over HTTP against the test server. The server now also
answers conditional interactions, `_elements`/`_summary` with the tag, and checks a token when
given one.

### SMART on FHIR (2026-11-20)

`packages/client/src/smart.ts`: SMART App Launch 2.x authorization. Each flow gives a token
provider for `bearerToken()`, so the client itself does not change.

```ts
const config = await discoverSmart(fhirBaseUrl);               // .well-known/smart-configuration

// a system, no user: client credentials with a signed JWT (backend services)
const backend = new SmartBackendServices({
  tokenEndpoint: config.token_endpoint, clientId, key: privateKey, alg: 'ES384', kid, scope: 'system/*.rs',
});
new FhirClient({ baseUrl: fhirBaseUrl, fhir, interceptors: [bearerToken(backend.provider)] });

// a user: authorization code with PKCE (standalone or EHR launch)
const app = new SmartAppLaunch({ configuration: config, fhirBaseUrl, clientId, redirectUri, scope: 'launch openid fhirUser patient/*.rs offline_access' });
const { url, pending } = await app.authorize({ launch });       // keep `pending` in the session, send the user to url
const session = await app.callback(callbackUrl, pending);       // tokens, patient, encounter, id_token
new FhirClient({ baseUrl: fhirBaseUrl, fhir, interceptors: [bearerToken(app.provider(session, store))] });
```

| Part | What it does |
| ---- | ------------ |
| `discoverSmart()` | Reads the server's endpoints and capabilities |
| `SmartBackendServices` | Signs a client assertion (RS384 or ES384, `iss` = `sub` = client id, `aud` = token endpoint, 5 minutes, a new `jti` each time); takes a `CryptoKey` or a private JWK; keeps the token until 30 s before it expires; a 401 gets a new one |
| `SmartAppLaunch` | `authorize()`: the URL with `state`, `aud`, `launch` and a PKCE S256 challenge. `callback()`: checks `state`, reports an `error`, trades the code (with the verifier). `refresh()`: the refresh token grant. `provider(session, onSession)`: refreshes before expiry and on 401; `onSession` hears of each new session, to store it |
| Clients | Public (`client_id` in the form) or confidential with a secret (`client_secret_basic`) |
| `SmartAuthError` | The authorization server's `error` and `error_description`, with the status |

Decisions:

- **Web Crypto** (`crypto.subtle`) signs and hashes: no dependency, and the same code runs in
  Node 22 and browsers. ES384 signatures come from Web Crypto as `r || s`, the form JWS takes.
- **No storage, no redirect.** Where `pending` and the session are kept (a server session, a
  browser's sessionStorage) and how the user is sent to the URL are the app's. The library
  checks `state` but does not hold it.
- **Token endpoints over https only** (localhost excepted): a client assertion, a code and a
  secret go to them. A server without S256 PKCE is refused.

Tests (`packages/client/test/smart.spec.ts`, 12) run against a test authorization server
(`test/_support/smart-test-server.ts`). The server:

- verifies the assertion's signature with the registered public key, and its claims, and refuses
  a `jti` it has seen;
- checks PKCE, the redirect URI and the client secret;
- issues codes that are good once.

The tests use key pairs generated for the run. Also covered: the FHIR test server takes the
issued tokens, a refresh on 401, a forged `state`, a refused authorization, and an unknown client.

Not done:

- `private_key_jwt` for app launch (confidential asymmetric clients).
- ~~Reading the `id_token`~~: done, see "SMART: the id_token".
- Dynamic client registration.
- Token introspection and revocation.
- Testing with a real authorization server (the SMART launcher, an EHR sandbox).

### SMART: the id_token (2026-11-20)

With `openid fhirUser` in the scope, the server sends an `id_token` (OpenID Connect) that names
the user. `SmartAppLaunch.callback()` now verifies it and gives the user in the session.

```ts
const session = await app.callback(callbackUrl, pending);
session.user.claims;     // the verified claims: iss, sub, aud, exp, fhirUser ...
session.user.fhirUser;   // 'Practitioner/pr1', or an absolute URL
session.user.reference;  // { type: 'Practitioner', id: 'pr1' } when it is on this FHIR server
await client.read(session.user.reference.type, session.user.reference.id);
```

`verifyIdToken(token, { issuer, clientId, nonce })` (`packages/client/src/id-token.ts`) checks:

| Check | How |
| ----- | --- |
| Signature | With the issuer's key: its `.well-known/openid-configuration` gives `jwks_uri`, the key is picked by `kid` and `alg`. The issuer is the one the SMART configuration names (or `issuer` given), never the token's own claim, so a token cannot point to keys of its choosing |
| Algorithm | RS256 (which SMART requires), RS384, ES256, ES384; `none`, `HS256` and others are refused |
| Claims | `iss` is the issuer, `aud` has the client (and `azp` is it when there are several), `exp` not passed and `iat` not in the future (60 s of clock difference), `nonce` the one sent |
| Keys | Kept an hour per issuer; a `kid` not known reads the set again once (key rotation) |
| URLs | The configuration and the key set only over https (localhost excepted) |

- `authorize()` sends a `nonce` when the scope has `openid` and keeps it in `pending`. A token
  replayed from another login fails.
- A refresh that brings a new id_token verifies it too (it has no nonce).
- `fhirUser` is read against the FHIR base URL. A user on another server has no `reference`,
  so the client is not sent there.
- `verifyIdToken: false` skips the check, for a server known not to sign id_tokens. The token
  is then in `session.idToken` and there is no `user`.

Tests (10 more, `packages/client/test/smart.spec.ts`): the test authorization server signs
id_tokens (RS256, with a key made at start) and publishes its configuration and key set. They
cover:

- a good token, with the `fhirUser` read through the client;
- an absolute `fhirUser`, on this server and on another;
- refusals: a token signed with another key, for another client, from another issuer,
  expired, or with another nonce; `none` and `HS256`;
- the key cache and a rotated `kid`;
- `verifyIdToken: false`.

## 13. Points to discuss

1. **Primitive extensions as plain `_x` properties.** Faithful to the wire and simple; awkward for
   arrays (`_given` runs parallel to `given`). Alternative: keep them off the instance, behind a
   helper only (`getExtension(p, 'birthDate', url)`).
   **Decided (2026-11-20):** plain `_x` properties, as implemented.
2. **Choice elements as one property per type** (`deceasedBoolean`, `deceasedDateTime`), as on
   the wire. Alternative: one property `deceased` holding `{ type, value }`, which reads better
   but differs from every other FHIR library and from the JSON.
   **Decided (2026-11-20):** one property per type (`deceasedBoolean`), as FHIR defines it in JSON.
3. **Extension and slice sugar.** A property that is not on the wire means `p` and `fhir.encode(p)`
   differ. Is that clear enough to users, or should sugar be getters over `extension`/`identifier`
   instead of separate storage?
   **Decided (2026-11-20):** separate storage, as implemented.
4. **`readonly resourceType`** set by the class, or a normal property the codec checks.
   **Decided (2026-11-20):** `readonly`, set by the class (a profile class gives its base's); the codec
   checks it, as implemented.
5. **Profile instances.** Should `decode()` return `TrPatient` automatically from `meta.profile`
   (step 2 in section 9), or only when asked?
   **Decided (2026-11-20):** automatically, when the profile class is registered in the context;
   `profiles: false` turns it off.
6. **One file per resource** with its backbone types, or one file per version.
   **Decided (2026-11-20):** one file per resource, with its backbone types, as generated.
7. **Class names of backbone types**: `PatientContact` (as `@types/fhir` and Medplum), or nested
   access `Patient.Contact` (a static property on the class).
   **Decided (2026-11-20):** `PatientContact`, as implemented.
