import { type FhirModel, fhirPathModelOf } from '@fhirjs/core';
import { FhirPath } from '@fhirjs/fhirpath';
import { expect } from 'expect';

/**
 * The invariants of a model's types that check() finds issues in, by
 * `key@where`: each checked against its context, a type's against the type,
 * an element's against the types the element may have
 */
export function invariantIssues(model: FhirModel, lenient: boolean) {
  const fp = new FhirPath({ model: fhirPathModelOf(model), lenient });
  const issues: Record<string, string> = {};
  let checked = 0;
  const check = (key: string, expression: string, type: string | string[]) => {
    checked++;
    const found = fp.check(expression, { type });
    if (found.length) issues[key] = found.map(i => i.message).join('; ');
  };
  for (const name of model.typeNames()) {
    const t = model.getType(name);
    for (const c of t.constraints)
      if (c.expression) check(`${c.key}@${t.path}`, c.expression, t.path);
    for (const el of t.elements.values()) {
      if (el.owner !== t) continue;
      for (const c of el.constraints)
        if (c.expression)
          check(
            `${c.key}@${t.path}.${el.name}`,
            c.expression,
            el.types.map(et => et.code),
          );
    }
  }
  return { checked, issues };
}

/**
 * A test that every invariant of the specification type-checks, but the
 * ones listed: errors of the specification, found by check()
 */
export function describeInvariantCheck(
  version: string,
  model: FhirModel,
  known: Record<string, string>,
  count: number,
) {
  describe(`check() on the ${version} invariants`, () => {
    for (const lenient of [false, true])
      it(`type-checks every invariant of ${version}${lenient ? ', lenient' : ''}, but errors of the specification`, () => {
        const { checked, issues } = invariantIssues(model, lenient);
        expect(checked).toBe(count);
        expect(issues).toEqual(known);
      });
  });
}
