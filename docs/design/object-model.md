# Design: object model, conversion and validation

Status: proposal, not decided. Refines section 6 of
[model-and-dictionary.md](model-and-dictionary.md).

The question: how a user of the library writes, reads and checks FHIR resources in TypeScript,
and whether the entity modelling of `opra` (`@ComplexType`, `@ApiField`) and `sqb` (`@Entity`,
`@Column`) fits.

## 1. What opra and sqb do

| Concern          | opra                                                   | sqb                                          |
| ---------------- | ------------------------------------------------------ | -------------------------------------------- |
| Model            | Class with `@ComplexType`; fields with `@ApiField`     | Class with `@Entity`; fields with `@Column`  |
| Metadata         | `Reflect` metadata, read into an `ApiDocument`         | `EntityMetadata` per class                   |
| Reuse            | `MixinType`, `PickType`, `OmitType`, `PartialType`     | Inheritance, `@Embedded`                     |
| Conversion       | `generateCodec('decode' \| 'encode')` builds a cached `valgen` validator per type, scope and projection | `@Parse`, `@Serialize` per column |
| Field mapping    | `scopePattern`, `override` per scope                   | `fieldName` (property to column)             |
| Instances        | `new Note(init)`; codec creates instances (`ctor`)     | `BaseEntity`, repository returns instances   |

Both keep the type in one place (the class) and derive conversion and validation from its
metadata. That is the part to reuse.

## 2. Where FHIR differs

1. **The source of the metadata is HL7, not the developer.** R4 has about 150 resources, 60 data
   types and several hundred backbone elements; R5 more. These classes are generated from
   StructureDefinitions. Developers write their own classes only for **profiles and extensions**.
2. **Size.** Three versions together are well over a thousand classes. Running a decorator for
   every field of every class at import time costs start-up time and stops tree-shaking.
3. **Element names cover common words.** `text`, `code`, `value`, `type`, `name`, `status`,
   `contained`, `language`, `meta` are FHIR elements. An instance method with such a name would
   collide with data. Methods on resource classes must be few, or not exist.
4. **The wire form has quirks a plain class does not have:**
   - primitive extensions: `birthDate` and `_birthDate`; for arrays, `_given` runs in parallel
     with `null`s;
   - choice elements: `value[x]` is one of `valueString`, `valueQuantity`, ...;
   - polymorphic resources: `Bundle.entry.resource`, `contained`, `Parameters.parameter.resource`
     are typed by their own `resourceType`;
   - decimals must keep their written precision (`1.50`);
   - dates have partial precision (`2024`, `2024-05`, `2024-05-01T10:00:00+03:00`).

## 3. Proposal: one metadata model, two ways to fill it

> Superseded by [decorator-model.md](decorator-model.md): core types are generated classes with
> the same decorators developers use. Sections 3 and 3.1 below are kept for the record.

```
                ┌──────────────────────────────┐
 HL7 packages ─▶│ build script (support/)      │──▶ compact data + generated classes
                └──────────────────────────────┘
                                │
                                ▼
 developer's    ┌──────────────────────────────┐
 @FhirProfile ─▶│ FhirTypeDefinition registry  │  one metadata model per version
 classes        │ (the dictionary)             │
                └──────────────────────────────┘
                                │ generateCodec / generateValidator (valgen, cached)
                                ▼
            decode (wire ▶ model)   encode (model ▶ wire)   validate (model ▶ OperationOutcome)
```

- **Core types: generated classes without decorators.** The fields are `declare`d, so they emit
  no JavaScript; a class compiles to one line linking it to its definition:

  ```ts
  export class Patient extends DomainResource {
    static readonly [FHIR_TYPE] = 'Patient';
    declare readonly resourceType: 'Patient';
    declare identifier?: Identifier[];
    declare name?: HumanName[];
    declare gender?: AdministrativeGender;      // 'male' | 'female' | 'other' | 'unknown'
    declare birthDate?: FhirDate;
    declare _birthDate?: Element;
    declare deceasedBoolean?: boolean;
    declare deceasedDateTime?: FhirDateTime;
    declare contact?: PatientContact[];
    declare managingOrganization?: Reference<'Organization'>;
    // ...
  }
  ```

  The metadata for these classes comes from the compact data, read on first use, as in
  `hl7v2-dictionary`. Classes have no side effects, so bundlers can tree-shake them.

- **Profiles and extensions: decorators, as in opra.** A developer's class extends a generated
  one; the decorators produce a `FhirTypeDefinition` registered in the same dictionary:

  ```ts
  @FhirProfile({ url: 'http://example.org/fhir/StructureDefinition/tr-patient' })
  export class TrPatient extends Patient {
    @FhirElement({ min: 1 })
    declare identifier: Identifier[];

    /* Sugar: a property that is an extension on the wire */
    @FhirExtension({ url: 'http://example.org/fhir/StructureDefinition/religion' })
    declare religion?: CodeableConcept;
  }
  ```

  `religion` is a property in code and `extension[url=...].valueCodeableConcept` on the wire;
  the codec maps it, like `sqb`'s `fieldName` maps a property to a column.

### 3.1 Where a generated class's field types are defined

A generated class has no decorators, so its field types are not on the class. They are in the
dictionary, and the class only names its entry. The chain for `Patient.name`:

1. **Compact data** (generated by the build script, `data/r4.js`), one tuple per element, like
   `hl7-data.js`:

   ```js
   // types: name -> [kind, base, elements]
   Patient: ['resource', 'DomainResource', [
     // [name, min, max, types, binding, flags]
     ['identifier', 0, '*', ['Identifier']],
     ['active', 0, 1, ['boolean'], null, MODIFIER | SUMMARY],
     ['name', 0, '*', ['HumanName'], null, SUMMARY],
     ['gender', 0, 1, ['code'], ['required', 'http://hl7.org/fhir/ValueSet/administrative-gender|4.0.1']],
     ['birthDate', 0, 1, ['date']],
     ['deceased[x]', 0, 1, ['boolean', 'dateTime'], null, MODIFIER | SUMMARY],
     ['contact', 0, '*', ['PatientContact']],          // a backbone element, its own entry
     ['managingOrganization', 0, 1, [['Reference', 'Organization']]],
   ]],
   HumanName: ['complex-type', 'Element', [ ['use', 0, 1, ['code'], [...]], ['family', 0, 1, ['string']], ... ]],
   ```

2. **The dictionary** reads that entry on first use into a frozen `FhirTypeDefinition`
   (`dict.types.Patient.elements.name` is `{ min: 0, max: Infinity, types: [{ code: 'HumanName' }] }`).

3. **The class registry**, also generated, maps type names to classes:
   `{ Patient: Patient, HumanName: HumanName, PatientContact: PatientContact, ... }`. The class
   points back with `static [FHIR_TYPE] = 'Patient'`.

4. **The codec generator** walks the definition: for `name` it finds type `HumanName`, takes its
   definition and its class from the registry, and builds
   `vg.isArray(vg.isObject(humanNameSchema, { ctor: HumanName }))`, the way opra's
   `_generateSchema` walks `ApiField`s. The result is cached per type and options.

5. **Primitive types** (`string`, `code`, `date`, `dateTime`, `decimal`, `integer64`, ...) are
   the end of every chain. They are written by hand in the core package, one module per type,
   like opra's `DateTimeType` with its `[DECODER]` and `[ENCODER]`: the regex from the spec, the
   JSON form, and the conversion (`decimal` keeps its text, `date` checks partial precision).
   About twenty per version, mostly shared.

The TypeScript `declare`d fields are written by the same generator from the same data, so the
compile-time types and the runtime definitions cannot drift apart. The class body is for the
compiler only; the data is for the runtime.

A developer's `@FhirProfile` class takes the other route to the same place: its decorators
produce a `FhirTypeDefinition` whose `base` is the generated type, and the dictionary merges the
two. From step 4 on there is no difference.

Alternative considered: the generator writes the definition into the class itself
(`static [FHIR_DEF] = { elements: { name: { type: () => HumanName, max: '*' } } }`). This keeps
type and class in one file and needs no registry, but every imported class carries its
metadata (larger bundle, no sharing between versions), and `decode()` of a Bundle still needs a
registry to find classes by `resourceType`. The data file is kept as the proposal.

- **Profiles from IG packages** (US Core, IPS, a national core) are loaded as data
  (`loadPackage()`), not classes. A CLI can later generate `@FhirProfile` classes from an IG.

One metadata model means one codec generator and one validator for both kinds.

## 4. User-facing API

A context ties a version, its dictionary and loaded packages together, like `hl7v2`'s
`dictionaries['2.5']` and HAPI's `FhirContext`:

```ts
import { FhirContext } from 'fhir';
import { Patient, Observation, Bundle } from 'fhir-models/r4';

const fhir = new FhirContext('R4', { packages: [usCore], profiles: [TrPatient] });

// Create: a class, initialised from a typed partial (as opra's `new Note(init)`)
const p = new Patient({
  name: [{ family: 'Yılmaz', given: ['Ayşe'] }],
  gender: 'female',
  birthDate: '1985-04-12',
});
p.gender = 'femal';                       // compile error

// Read from the wire: the instance's class follows resourceType
const res = fhir.decode(json);            // R4.Resource (a Patient instance here)
const pat = fhir.decode(json, Patient);   // Patient; throws if resourceType differs
const bundle = fhir.decode(text, Bundle); // entries are instances of their own classes

// Write to the wire
fhir.encode(p);                           // FHIR JSON object
fhir.stringify(p);                        // JSON text; decimals keep precision
// later: fhir.encode(p, { format: 'xml' })

// Validate
const outcome = fhir.validate(p, { profile: TrPatient.url });  // OperationOutcome
if (!outcome.ok) console.log(outcome.issue);
```

Helpers are functions, not instance methods, because of point 3 in section 2:

```ts
import { getExtension, setExtension, choice, resolveReference, path } from 'fhir';

getExtension(p, 'http://example.org/.../religion');           // Extension | undefined
getExtension(p, 'birthDate', 'http://hl7.org/.../birthTime');  // on a primitive (_birthDate)
choice(obs, 'value');                                           // { type: 'Quantity', value }
resolveReference(bundle, obs.subject);                          // Patient | undefined
path(p, 'name[0].given[0]');                                    // typed path access
fhir.evaluate(p, "name.where(use = 'official').family");        // FHIRPath
```

The only instance members are `toJSON()` (so `JSON.stringify(p)` gives the wire form) and
symbol-keyed internals.

Plain objects are accepted everywhere a class is: `fhir.encode({ resourceType: 'Patient', ... })`
works, and `fhir.decode(json, { plain: true })` returns plain objects for users who do not want
classes.

## 5. Conversion layer (codec)

Built like opra's `ComplexTypeBase.generateCodec()`: for each type and option set, one `valgen`
validator, generated from the definition and cached. Circular types (`Extension.extension`,
`Questionnaire.item.item`, `Identifier.assigner -> Reference -> Identifier`) use the forward
callbacks opra already uses.

| Step                 | decode (wire ▶ model)                                     | encode (model ▶ wire)                         |
| -------------------- | --------------------------------------------------------- | --------------------------------------------- |
| Resource class       | Picks the class by `resourceType` (and profile, if asked) | Writes `resourceType` first                   |
| Element order        | Any                                                       | The order of the definition                   |
| Primitive extensions | Keeps `_x` with `x`; checks parallel arrays               | Writes `_x` only when it has content; `null`s in arrays |
| Choice elements      | Accepts one `value*` key; more than one is an error       | Unchanged                                     |
| Decimal              | Number, or exact text with a precision option             | The text it was read as, when kept           |
| Date/time            | String as written; option to give `Date` for full instants | String; a `Date` becomes an `instant`       |
| Extension sugar      | `extension[url]` ▶ decorated property                     | Decorated property ▶ `extension[url]`        |
| Unknown elements     | `strict`: error; default: keep, report as a warning       | Written as kept                               |
| Empty values         | Rejected (`""`, `{}`, `[]` are invalid in FHIR)           | Removed                                       |

Like opra, a codec can take options that change its shape: `partial` (for PATCH bodies),
`summary` (only `isSummary` elements, for `_summary=true`), `elements` (the `_elements`
parameter, like opra's projection).

## 6. Validation layer

Levels, each a separate option so a caller pays only for what it needs:

| Level          | Checks                                                                 | Where           |
| -------------- | ---------------------------------------------------------------------- | --------------- |
| `structure`    | Known elements, types, cardinality, primitive regex, empty values     | In the codec    |
| `bindings`     | Codes of `required` bindings in the dictionary's value sets           | In the codec    |
| `invariants`   | Constraints (`ele-1`, `pat-1`, ...) as FHIRPath                         | After the codec |
| `profiles`     | `meta.profile` and requested profiles: cardinality, fixed/pattern, slicing | After the codec |
| `terminology`  | Other bindings, through a terminology server (`$validate-code`); async | Optional        |

The result is always an `OperationOutcome` with FHIRPath locations
(`Patient.name[0].given[0]`), the same form a server returns, so the client and a server share
it. `valgen` issues are mapped to `OperationOutcome.issue`.

`decode()` runs `structure` and `bindings` by default (they are cheap and part of the codec);
`validate()` runs the levels it is given.

## 7. Packages

| Package          | Content                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| core (`fhir-*`)  | Base classes, decorators, `FhirContext`, codec, validator, FHIRPath, helpers |
| `fhir-models`    | Per version (`fhir-models/r4`, `/r4b`, `/r5`): generated classes, types, compact data |
| `fhir-client`    | REST client; returns instances through a context                           |

This is the hl7v2 split with "dictionary" named after what users import from it. One package
with sub-path exports keeps three packages; one package per version is the alternative if the
size of one package becomes a problem.

## 8. Risks

- **Decorator flavour.** opra uses legacy decorators with `reflect-metadata`. Generated classes
  need no decorators; user profiles do. Choosing legacy keeps one style with opra; TC39 standard
  decorators need no compiler flag but no `design:type`, so the type must be given explicitly.
- **Type-check time.** Thousands of interfaces per version can slow `tsc`. Per-version
  sub-path exports keep a project to the version it imports. To be measured with the generator.
- **Instances vs plain objects.** Class instances cost a prototype per object; `structuredClone`
  returns plain objects. The codec must accept both, and tests must cover both.

## 9. Open decisions

- Generated classes (proposal) or generated interfaces only, with classes only for profiles.
- Decorator flavour: legacy, as opra, or TC39 standard.
- Primitive extensions as `_x` siblings (proposal; same as the wire and `@types/fhir`), or
  wrapped primitives (`birthDate.value`, as HAPI and Firely do).
- Decimal default: number, or exact text.
- Helpers as functions (proposal), or `$`-prefixed instance methods (`p.$getExtension()`).
- ~~One `fhir-models` package with sub-paths, or a package per version~~: decided, a package per version (`@fhirjs/r4`).
