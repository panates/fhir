import fs from 'node:fs';
import path from 'node:path';
import { FhirContext } from '@fhirjs/core';
import { expect } from 'expect';
import {
  hasPackage,
  packagePath,
} from '../../core/test/_support/conformance.js';
import { r4bModel } from '../src/index.js';

const R4B_EXAMPLES = packagePath('hl7.fhir.r4b.examples#4.3.0');

describe('R4B validate()', () => {
  it('runs the R4B invariants on every example, and finds the invalid ones', function () {
    if (!hasPackage(R4B_EXAMPLES)) return this.skip();
    this.timeout(120000);
    const fhir = new FhirContext(r4bModel);
    const byReason: Record<string, number> = {};
    const exceptions: string[] = [];
    for (const file of fs.readdirSync(R4B_EXAMPLES)) {
      if (
        !file.endsWith('.json') ||
        file === 'package.json' ||
        file.startsWith('.')
      )
        continue;
      const r = fhir.validate(
        JSON.parse(fs.readFileSync(path.join(R4B_EXAMPLES, file), 'utf8')),
      );
      for (const i of r.issues)
        if (i.code === 'exception') exceptions.push(`${file} ${i.diagnostics}`);
      if (r.valid) continue;
      const reasons = new Set(
        r.issues
          .filter(i => i.severity === 'error')
          .map(i =>
            i.code === 'invariant' ? i.diagnostics.split(':')[0] : i.code,
          ),
      );
      for (const x of reasons) byReason[x] = (byReason[x] || 0) + 1;
    }
    // R4B's sdf-24 calls length() on an ElementDefinition ($this); R5 corrected it to $this.path
    expect(
      exceptions.filter(
        e =>
          !e.includes(
            'sdf-24 could not be evaluated: length() expects a String',
          ),
      ),
    ).toEqual([]);
    expect(new Set(exceptions.map(e => e.split(' ')[0])).size).toBe(6); // files with it
    // All real, checked by hand: the codec's 13 missing required elements and an
    // id over 64 characters; narrower mappings without a comment (cmd-1); a
    // repeated code (csd-1, indicated-only-before) and repeated linkIds (que-2);
    // logical models without baseDefinition (sdf-4) and bindings with neither a
    // value set nor a description (sdf-10)
    expect(byReason).toEqual({
      required: 13,
      value: 1,
      'cmd-1': 4,
      'csd-1': 2,
      'que-2': 1,
      'sdf-4': 4,
      'sdf-10': 3,
    });
  });
});
