import { isDeepStrictEqual } from 'node:util';
import { expect } from 'expect';
import { FhirCodecError, FhirContext } from '@fhirjs/core';
import { r4Model } from '../src/index.js';
import {
  hasPackage,
  packageResources,
  R4_EXAMPLES,
} from './_support/packages.js';

/*
 * Every resource of hl7.fhir.r4.examples, through the codec. These examples
 * are invalid in the specification itself: required elements are missing.
 */
const INVALID_EXAMPLES: Record<string, string> = {
  'ImplementationGuide-fhir.json': 'ImplementationGuide.name: name is required',
  'Questionnaire-qs1.json':
    'Questionnaire.item[0].item[0].linkId: linkId is required',
  'SearchParameter-codesystem-extensions-CodeSystem-author.json':
    'SearchParameter.base: base is required',
  'SearchParameter-codesystem-extensions-CodeSystem-effective.json':
    'SearchParameter.base: base is required',
  'SearchParameter-codesystem-extensions-CodeSystem-end.json':
    'SearchParameter.base: base is required',
  'SearchParameter-codesystem-extensions-CodeSystem-keyword.json':
    'SearchParameter.base: base is required',
  'SearchParameter-codesystem-extensions-CodeSystem-workflow.json':
    'SearchParameter.base: base is required',
  'SearchParameter-valueset-extensions-ValueSet-author.json':
    'SearchParameter.base: base is required',
  'SearchParameter-valueset-extensions-ValueSet-effective.json':
    'SearchParameter.base: base is required',
  'SearchParameter-valueset-extensions-ValueSet-end.json':
    'SearchParameter.base: base is required',
  'SearchParameter-valueset-extensions-ValueSet-keyword.json':
    'SearchParameter.base: base is required',
  'SearchParameter-valueset-extensions-ValueSet-workflow.json':
    'SearchParameter.base: base is required',
  'ig-r4.json': 'ImplementationGuide.name: name is required',
};

/** key=source of every number JSON.parse writes back differently (1.50) */
function lossyNumbers(text: string): string[] {
  const out: string[] = [];
  JSON.parse(text, (key, value, context?: { source?: string }) => {
    if (typeof value === 'number' && context?.source !== String(value))
      out.push(`${key}=${context?.source}`);
    return value;
  });
  return out.sort();
}

describe('R4 examples (hl7.fhir.r4.examples)', function () {
  before(function () {
    if (!hasPackage(R4_EXAMPLES)) this.skip();
  });

  it('decodes and encodes every valid example back to its source', () => {
    const fhir = new FhirContext(r4Model);
    const differ: string[] = [];
    const failed: Record<string, string> = {};
    let ok = 0;
    for (const [file, json] of packageResources(R4_EXAMPLES)) {
      let res: any;
      try {
        res = fhir.decode(json);
      } catch (e) {
        if (!(e instanceof FhirCodecError)) throw e;
        const first = e.issues[0];
        failed[file] = `${first.expression}: ${first.diagnostics}`;
        continue;
      }
      if (res.constructor !== r4Model.getType(json.resourceType).ctor)
        differ.push(`${file}: class`);
      else if (!isDeepStrictEqual(fhir.encode(res), json)) differ.push(file);
      else ok++;
    }
    expect(differ).toEqual([]);
    expect(failed).toEqual(INVALID_EXAMPLES);
    expect(ok).toBe(5296);
  });

  it('keeps the precision of decimals through decode(text) and stringify()', () => {
    const fhir = new FhirContext(r4Model);
    let files = 0;
    let numbers = 0;
    const lost: string[] = [];
    for (const [file, , text] of packageResources(R4_EXAMPLES)) {
      if (INVALID_EXAMPLES[file]) continue;
      const source = lossyNumbers(text);
      if (!source.length) continue;
      files++;
      numbers += source.length;
      const written = lossyNumbers(fhir.stringify(fhir.decode(text)));
      for (const n of source)
        if (!written.includes(n)) lost.push(`${file}: ${n}`);
    }
    expect(lost).toEqual([]);
    expect([files, numbers]).toEqual([42, 319]);
  });
});
