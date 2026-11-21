/**
 * Codec speed on examples of the specification, and on the whole examples
 * package when it is there. Reads the built packages: run `pnpm build` first.
 *
 *   node support/bench-codec.mts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { EXAMPLES, packageDir } from './fetch-packages.mts';

const { FhirContext } = await import('../packages/core/build/index.js');
const { r4Model } = await import('../packages/r4/build/index.js');

const fhir = new FhirContext(r4Model);
const dir = packageDir('R4', EXAMPLES);
if (!existsSync(dir)) {
  console.log('Run node support/fetch-packages.mts first');
  process.exit(1);
}

function bench(fn: () => unknown, n = 20000): number {
  for (let i = 0; i < n / 10; i++) fn();
  const t = performance.now();
  for (let i = 0; i < n; i++) fn();
  return ((performance.now() - t) / n) * 1000;
}

const µs = (v: number) => v.toFixed(1).padStart(6) + ' µs';
console.log(
  'per resource (warm)      size   JSON.parse  decode(obj) decode(text) encode     stringify',
);
for (const file of [
  'Patient-example.json',
  'Observation-example.json',
  'Observation-decimal.json',
  'Bundle-bundle-example.json',
]) {
  const text = readFileSync(path.join(dir, file), 'utf8');
  const json = JSON.parse(text);
  const res = fhir.decode(text);
  console.log(
    file.replace('.json', '').padEnd(22),
    String(text.length).padStart(6),
    µs(bench(() => JSON.parse(text))),
    µs(bench(() => fhir.decode(json))),
    µs(bench(() => fhir.decode(text))),
    µs(bench(() => fhir.encode(res))),
    µs(bench(() => fhir.stringify(res))),
  );
}

let bytes = 0;
let decodeMs = 0;
let encodeMs = 0;
let count = 0;
for (const file of readdirSync(dir)) {
  if (
    !file.endsWith('.json') ||
    file.startsWith('.') ||
    file === 'package.json'
  )
    continue;
  const text = readFileSync(path.join(dir, file), 'utf8');
  let res: unknown;
  const t0 = performance.now();
  try {
    res = fhir.decode(text);
  } catch {
    continue;
  }
  const t1 = performance.now();
  fhir.stringify(res as object);
  encodeMs += performance.now() - t1;
  decodeMs += t1 - t0;
  bytes += text.length;
  count++;
}
console.log(
  `\nwhole package: ${count} resources, ${(bytes / 1048576).toFixed(0)} MB: ` +
    `decode(text) ${decodeMs.toFixed(0)} ms, stringify ${encodeMs.toFixed(0)} ms`,
);
