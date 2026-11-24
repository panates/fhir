import { expect } from 'expect';
import { Patient, PatientContact, r4Model } from '../src/index.js';
import { hasPackage, packageResources, R4_CORE } from './_support/packages.js';

const FHIR_TYPE_EXT =
  'http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type';
const SYSTEM_PREFIX = 'http://hl7.org/fhirpath/System.';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const pathToName = (p: string) => p.split('.').map(cap).join('');

describe('R4 model', () => {
  it('builds every type from its decorators', () => {
    const names = [...r4Model.typeNames()];
    expect(names.length).toBe(682);
    for (const n of names) expect(r4Model.getType(n).name).toBe(n);
    expect(r4Model.resourceTypes()).toHaveLength(146);
  });

  it('gives a resource its own and inherited elements', () => {
    const t = r4Model.getType(Patient);
    expect(t.base?.name).toBe('DomainResource');
    expect(t.isA('Resource')).toBe(true);
    expect([...t.elements.keys()].slice(0, 4)).toEqual([
      'id',
      'meta',
      'implicitRules',
      'language',
    ]);
    expect(t.getElement('name')).toMatchObject({
      min: 0,
      max: Infinity,
      isArray: true,
      summary: true,
    });
  });

  it('joins a choice into one element', () => {
    const el = r4Model.getType('Patient').getElement('deceasedDateTime')!;
    expect(el.name).toBe('deceased[x]');
    expect(el.types.map(t => t.key)).toEqual([
      'deceasedBoolean',
      'deceasedDateTime',
    ]);
    expect(el.getType(1).regex).toMatch(/^\(\[0-9\]/);
  });

  it('puts a backbone element in its own type, with its constraints', () => {
    const contact = r4Model.getType(Patient).getElement('contact')!.getType();
    expect(contact.ctor).toBe(PatientContact);
    expect(contact.path).toBe('Patient.contact');
    expect(contact.constraints.map(c => c.key)).toEqual(['pat-1']);
  });

  it('has the codes of required bindings', () => {
    const vs = r4Model.getValueSet(
      'http://hl7.org/fhir/ValueSet/administrative-gender|4.0.1',
    )!;
    expect(vs.has('female')).toBe(true);
    expect(vs.has('femal')).toBe(false);
    expect(vs.has('male', 'http://hl7.org/fhir/administrative-gender')).toBe(
      true,
    );
    expect(
      r4Model.getValueSet('http://hl7.org/fhir/ValueSet/mimetypes'),
    ).toBeUndefined();
  });

  /* The generated model against the StructureDefinitions it came from */
  it('matches the snapshots of hl7.fhir.r4.core, element by element', function () {
    if (!hasPackage(R4_CORE)) return this.skip();
    const errors: string[] = [];
    let checked = 0;
    for (const [, sd] of packageResources(R4_CORE, 'StructureDefinition-')) {
      if (
        !['complex-type', 'resource'].includes(sd.kind) ||
        sd.derivation === 'constraint'
      )
        continue;
      for (const ed of sd.snapshot.element) {
        const segs: string[] = ed.path.split('.');
        if (segs.length < 2) continue;
        const owner = r4Model.getType(
          segs.length === 2 ? sd.type : pathToName(segs.slice(0, -1).join('.')),
        );
        const el = owner.getElement(segs[segs.length - 1]);
        const where = ed.path;
        if (!el) {
          errors.push(`${where}: missing`);
          continue;
        }
        checked++;
        if (el.min !== ed.min)
          errors.push(`${where}: min ${el.min} != ${ed.min}`);
        if (el.max !== (ed.max === '*' ? Infinity : Number(ed.max)))
          errors.push(`${where}: max`);
        const expected = ed.contentReference
          ? [pathToName(ed.contentReference.replace(/^.*#/, ''))]
          : ed.type.map((t: any) =>
              t.code.startsWith(SYSTEM_PREFIX)
                ? t.extension?.find((x: any) => x.url === FHIR_TYPE_EXT)
                    ?.valueUrl
                : t.code === 'BackboneElement' || t.code === 'Element'
                  ? pathToName(ed.path)
                  : t.code,
            );
        if (el.types.map(t => t.code).join() !== expected.join())
          errors.push(`${where}: types`);
        el.types.forEach((t, i) => {
          el.getType(i);
          const targets = ed.type?.[i]?.targetProfile
            ?.map((u: string) => u.split('/').pop())
            .join();
          if ((t.targets?.join() || undefined) !== (targets || undefined))
            errors.push(`${where}: targets`);
        });
        if (
          (el.binding?.valueSet || undefined) !==
          (ed.binding?.valueSet || undefined)
        )
          errors.push(`${where}: binding`);
        if (el.summary !== !!ed.isSummary) errors.push(`${where}: summary`);
        if (el.modifier !== !!ed.isModifier) errors.push(`${where}: modifier`);
      }
    }
    expect(errors).toEqual([]);
    expect(checked).toBe(7406);
  });
});
