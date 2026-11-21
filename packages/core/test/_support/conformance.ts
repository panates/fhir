import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  FhirCodecError,
  type FhirContext,
  type FhirModel,
} from '../../src/index.js';

/*
 * Checks shared by the tests of every FHIR version package: a generated model
 * against the snapshots it came from, and a round trip of the examples.
 */

const FHIR_TYPE_EXT =
  'http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type';
const SYSTEM_PREFIX = 'http://hl7.org/fhirpath/System.';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const pathToName = (p: string) => p.split('.').map(cap).join('');

/** The folder of a downloaded HL7 package (support/fetch-packages.mts) */
export function packagePath(id: string): string {
  return path.join(
    import.meta.dirname,
    '../../../../support/fhir-packages',
    id,
    'package',
  );
}

export function hasPackage(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'package.json'));
}

/** The resources of a package: file name, parsed JSON, text */
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

/**
 * Every element of every type and resource of a core package against the
 * model: min, max, types, targets, binding, summary, modifier
 */
export function compareWithSnapshots(
  model: FhirModel,
  coreDir: string,
  /** A difference the specification itself has, by element path and what differs */
  known: (path: string, what: string) => boolean = () => false,
): { checked: number; errors: string[] } {
  const errors: string[] = [];
  let checked = 0;
  const report = (where: string, what: string, detail = '') => {
    if (!known(where, what)) errors.push(`${where}: ${what}${detail}`);
  };
  for (const [, sd] of packageResources(coreDir, 'StructureDefinition-')) {
    if (
      !['complex-type', 'resource'].includes(sd.kind) ||
      sd.derivation === 'constraint'
    )
      continue;
    for (const ed of sd.snapshot.element) {
      const segs: string[] = ed.path.split('.');
      if (segs.length < 2) continue;
      const owner = model.getType(
        segs.length === 2 ? sd.type : pathToName(segs.slice(0, -1).join('.')),
      );
      const el = owner.getElement(segs[segs.length - 1]);
      const where = ed.path;
      if (!el) {
        report(where, 'missing');
        continue;
      }
      checked++;
      if (el.min !== ed.min) report(where, 'min', ` ${el.min} != ${ed.min}`);
      if (el.max !== (ed.max === '*' ? Infinity : Number(ed.max)))
        report(where, 'max');
      const expected = ed.contentReference
        ? [pathToName(ed.contentReference.replace(/^.*#/, ''))]
        : ed.type.map((t: any) =>
            t.code.startsWith(SYSTEM_PREFIX)
              ? t.extension?.find((x: any) => x.url === FHIR_TYPE_EXT)?.valueUrl
              : t.code === 'BackboneElement' || t.code === 'Element'
                ? pathToName(ed.path)
                : t.code,
          );
      const actual = el.types.map(t => t.code);
      if (actual.join() !== expected.join())
        report(where, 'types', ` ${actual} != ${expected}`);
      el.types.forEach((t, i) => {
        el.getType(i);
        const targets = ed.type?.[i]?.targetProfile
          ?.map((u: string) => u.split('/').pop())
          .join();
        if ((t.targets?.join() || undefined) !== (targets || undefined))
          report(where, 'targets');
      });
      if (
        (el.binding?.valueSet || undefined) !==
        (ed.binding?.valueSet || undefined)
      )
        report(where, 'binding');
      if (el.summary !== !!ed.isSummary) report(where, 'summary');
      if (el.modifier !== !!ed.isModifier) report(where, 'modifier');
    }
  }
  return { checked, errors };
}

/**
 * Every example of a package: decoded (as the class of its resourceType),
 * encoded, and compared with the source
 */
export function roundTripExamples(
  fhir: FhirContext,
  dir: string,
): { ok: number; failed: Record<string, string>; differ: string[] } {
  const failed: Record<string, string> = {};
  const differ: string[] = [];
  let ok = 0;
  for (const [file, json] of packageResources(dir)) {
    let res: any;
    try {
      res = fhir.decode(json);
    } catch (e) {
      if (!(e instanceof FhirCodecError)) throw e;
      failed[file] = `${e.issues[0].expression}: ${e.issues[0].diagnostics}`;
      continue;
    }
    if (res.constructor !== fhir.model.getType(json.resourceType).ctor)
      differ.push(`${file}: class`);
    else if (!isDeepStrictEqual(fhir.encode(res), json)) differ.push(file);
    else ok++;
  }
  return { ok, failed, differ };
}

/** key=source of every number JSON.parse writes back differently (1.50) */
export function lossyNumbers(text: string): string[] {
  const out: string[] = [];
  JSON.parse(text, (key, value, context?: { source?: string }) => {
    if (typeof value === 'number' && context?.source !== String(value))
      out.push(`${key}=${context?.source}`);
    return value;
  });
  return out.sort();
}

/** Decimals of the examples through decode(text) and stringify(): what is lost */
export function decimalPrecision(
  fhir: FhirContext,
  dir: string,
  skip: Record<string, unknown> = {},
): { files: number; numbers: number; lost: string[] } {
  let files = 0;
  let numbers = 0;
  const lost: string[] = [];
  for (const [file, , text] of packageResources(dir)) {
    if (skip[file]) continue;
    const source = lossyNumbers(text);
    if (!source.length) continue;
    files++;
    numbers += source.length;
    const written = lossyNumbers(fhir.stringify(fhir.decode(text)));
    for (const n of source)
      if (!written.includes(n)) lost.push(`${file}: ${n}`);
  }
  return { files, numbers, lost };
}
