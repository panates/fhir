import fs from 'node:fs';
import path from 'node:path';

/*
 * The HL7 packages the tests compare with, downloaded by
 * `node support/fetch-packages.mts` (not in the repository). Tests that need
 * them are skipped when they are absent.
 */
export const PACKAGE_CACHE = path.join(
  import.meta.dirname,
  '../../../../support/fhir-packages',
);
const root = PACKAGE_CACHE;

export const R4_CORE = path.join(root, 'hl7.fhir.r4.core#4.0.1/package');
export const R4_EXAMPLES = path.join(
  root,
  'hl7.fhir.r4.examples#4.0.1/package',
);
export const US_CORE = path.join(root, 'hl7.fhir.us.core#6.1.0/package');

export function hasPackage(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'package.json'));
}

/** The resources of a package: file name and parsed JSON */
export function* packageResources(
  dir: string,
  prefix = '',
): Generator<[string, any, string]> {
  for (const file of fs.readdirSync(dir).sort()) {
    if (
      !file.endsWith('.json') ||
      file.startsWith('.') ||
      file === 'package.json'
    )
      continue;
    if (prefix && !file.startsWith(prefix)) continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    yield [file, JSON.parse(text), text];
  }
}
