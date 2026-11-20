/**
 * Downloads the FHIR core packages the generator reads, and the implementation
 * guides the tests load with their dependencies, into
 * support/fhir-packages/<name>#<version>/ (not committed).
 *
 * The packages are published by HL7 under CC0 at packages.fhir.org.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const PACKAGES: Record<string, { name: string; version: string }> = {
  R4: { name: 'hl7.fhir.r4.core', version: '4.0.1' },
  R4B: { name: 'hl7.fhir.r4b.core', version: '4.3.0' },
  R5: { name: 'hl7.fhir.r5.core', version: '5.0.0' },
};

/** Implementation guides the package loader is tested with */
export const IGS: Record<string, { name: string; version: string }> = {
  usCore: { name: 'hl7.fhir.us.core', version: '6.1.0' },
};

/** Example resources of the specification, for the codec tests */
export const EXAMPLES: Record<string, { name: string; version: string }> = {
  R4: { name: 'hl7.fhir.r4.examples', version: '4.0.1' },
  R4B: { name: 'hl7.fhir.r4b.examples', version: '4.3.0' },
  R5: { name: 'hl7.fhir.r5.examples', version: '5.0.0' },
};

const root = path.join(import.meta.dirname, 'fhir-packages');

export function packageDir(
  version: keyof typeof PACKAGES,
  set: Record<string, { name: string; version: string }> = PACKAGES,
): string {
  const pkg = set[version];
  return path.join(root, `${pkg.name}#${pkg.version}`, 'package');
}

async function fetchPackage(name: string, version: string) {
  const dir = path.join(root, `${name}#${version}`);
  if (existsSync(path.join(dir, 'package', 'package.json'))) {
    console.log(`${name}#${version}: present`);
    return;
  }
  const url = `https://packages.fhir.org/${name}/${version}`;
  console.log(`${name}#${version}: downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'package.tgz');
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  execFileSync('tar', ['-xzf', file, '-C', dir]);
}

/**
 * HL7's FHIRPath test suites (FHIR/fhir-test-cases, at a fixed commit) and
 * the inputs their tests read, as the suites name them, into
 * support/fhir-packages/fhirpath-tests@<commit>/<r4|r4b|r5>/. XML inputs are read
 * with the model by the tests.
 */
export const FHIRPATH_TESTS = {
  commit: '2cfcc672d39fe85dcf358106969cf63e185fd926',
  suites: {
    r4: [
      'r4/fhirpath/tests-fhir-r4.xml',
      'r4/patient-example.xml',
      'r4/patient-example-period.xml',
      'r4/observation-example.xml',
      'r4/questionnaire-example.xml',
      'r4/codesystem-example.xml',
      'r4/valueset-example-expansion.xml',
      'r4/parameters-example-decimals.xml',
      'r4/parameters-example-quantities.xml',
      'r4/parameters-example-types.xml',
      'r4/parameters-quantity-unit-text.xml',
      'r4/explanationofbenefit-example.json',
      'r4/appointment-examplereq.json',
      'r4/patient-container-example.json',
      'r4/patient-name-extensions.json',
      'r4/bundle-document-ips.json',
    ],
    r4b: [
      'r4b/fhirpath/tests-fhir-r4b.xml',
      'r4b/patient-example.xml',
      'r4b/patient-example-period.xml',
      'r4b/observation-example.xml',
      'r4b/questionnaire-example.xml',
      'r4b/codesystem-example.xml',
      'r4b/valueset-example-expansion.xml',
      'r4b/parameters-example-decimals.xml',
      'r4b/parameters-example-quantities.xml',
      'r4b/parameters-example-types.xml',
      'r4b/parameters-quantity-unit-text.xml',
      'r4b/explanationofbenefit-example.json',
      'r4b/appointment-examplereq.json',
      'r4b/patient-container-example.json',
      'r4b/bundle-document-ips.json',
    ],
    r5: [
      'r5/fhirpath/tests-fhir-r5.xml',
      'r5/patient-example.xml',
      'r5/patient-example-name.xml',
      'r5/patient-example-period.xml',
      'r5/observation-example.xml',
      'r5/questionnaire-example.xml',
      'r5/codesystem-example.xml',
      'r5/conceptmap-example.xml',
      'r5/valueset-example-expansion.xml',
      'r5/parameters-example-decimals.xml',
      'r5/parameters-example-html.xml',
      'r5/parameters-example-quantities.xml',
      'r5/parameters-example-types.xml',
      'r5/parameters-quantity-unit-text.xml',
      'r5/ccda.xml',
      'r5/explanationofbenefit-example.json',
      'r5/appointment-examplereq.json',
      'r5/diagnosticreport-eric.json',
      'r5/patient-container-example.json',
      'r5/patient-name-extensions.json',
      'r5/bundle-document-ips.json',
    ],
  },
};

/** The folder of a version's FHIRPath suite and its inputs */
export function fhirPathTestsDir(version: 'r4' | 'r4b' | 'r5'): string {
  return path.join(root, `fhirpath-tests@${FHIRPATH_TESTS.commit}`, version);
}

async function fetchFhirPathTests() {
  for (const [version, files] of Object.entries(FHIRPATH_TESTS.suites)) {
    const dir = fhirPathTestsDir(version as 'r4' | 'r4b' | 'r5');
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      const target = path.join(dir, path.basename(file));
      if (existsSync(target)) continue;
      const url = `https://raw.githubusercontent.com/FHIR/fhir-test-cases/${FHIRPATH_TESTS.commit}/${file}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      writeFileSync(target, Buffer.from(await res.arrayBuffer()));
    }
    console.log(`FHIRPath tests (${version}): ${dir}`);
  }
}

/**
 * The implementation guides and their dependencies, through the library's
 * own package cache (needs `pnpm build`)
 */
async function fetchWithDependencies() {
  const { FhirPackageCache } = await import('../packages/core/build/index.js');
  const cache = new FhirPackageCache({ dir: root, download: true });
  for (const { name, version } of Object.values(IGS)) {
    const r = await cache.resolve(name, version);
    console.log(
      `${name}#${version}: ${r.packages.map((p: any) => p.id).join(', ')}`,
    );
    if (r.skipped.length) console.log(`  skipped: ${r.skipped.join(', ')}`);
    if (r.conflicts.length)
      console.log(`  conflicts: ${r.conflicts.join('; ')}`);
  }
}

if (import.meta.main) {
  for (const { name, version } of [
    ...Object.values(PACKAGES),
    ...Object.values(EXAMPLES),
  ])
    await fetchPackage(name, version);
  await fetchWithDependencies();
  await fetchFhirPathTests();
}
