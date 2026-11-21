import { type FhirModel, type FhirSearchParameter } from '@fhirjs/core';
import { FhirPath } from '@fhirjs/fhirpath';
import { expect } from 'expect';

/**
 * The search parameter table a generated package gives its model: what the
 * generator keeps of the core package's SearchParameter resources.
 */
export function describeSearchParameters(
  version: string,
  model: FhirModel,
  table: FhirSearchParameter[],
  count: number,
  /** 'Base.code' of the parameters without an expression */
  noExpression: string[],
) {
  describe(`Search parameters of ${version}`, () => {
    it(`lists ${count}, none of them an example`, () => {
      expect(table).toHaveLength(count);
      expect(table.filter(p => /\/example/.test(p.url))).toEqual([]);
    });

    it('gives a type its own parameters and those of its base types', () => {
      const birthdate = model.getSearchParameter('Patient', 'birthdate')!;
      expect(birthdate).toMatchObject({ type: 'date' });
      expect(birthdate.expression).toContain('Patient.birthDate');
      // _id is Resource's, not the package's example of it
      expect(model.getSearchParameter('Patient', '_id')).toMatchObject({
        url: 'http://hl7.org/fhir/SearchParameter/Resource-id',
        type: 'token',
        base: ['Resource'],
      });
      expect(model.getSearchParameter('Condition', 'subject')?.url).toBe(
        'http://hl7.org/fhir/SearchParameter/Condition-subject',
      );
      expect(model.getSearchParameter('Patient', 'nonsense')).toBeUndefined();
      expect(model.searchParameters('NoSuchType').size).toBe(0);
    });

    it('names known types, and gives expressions FHIRPath can parse', () => {
      const fp = new FhirPath();
      const problems: string[] = [];
      for (const p of table) {
        for (const b of p.base)
          if (!model.hasType(b)) problems.push(`${p.url}: base ${b}`);
        for (const t of p.target ?? [])
          if (!model.hasType(t)) problems.push(`${p.url}: target ${t}`);
        for (const e of [
          p.expression,
          ...(p.component ?? []).map(c => c.expression),
        ]) {
          if (!e) continue;
          try {
            fp.compile(e);
          } catch (err) {
            problems.push(`${p.url}: ${(err as Error).message}`);
          }
        }
      }
      expect(problems).toEqual([]);
    });

    it('has an expression for every parameter but those listed', () => {
      expect(
        table
          .filter(p => !p.expression)
          .map(p => `${p.base.join(',')}.${p.code}`)
          .sort(),
      ).toEqual(noExpression);
      expect(
        table.filter(p => p.type === 'composite' && !p.component?.length),
      ).toEqual([]);
    });
  });
}
