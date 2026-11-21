import fs from 'node:fs';
import path from 'node:path';
import { fhirPathModelOf } from '@fhirjs/core';
import { expect } from 'expect';
import { type FhirModel, parseFhirJson } from '@fhirjs/core';
import {
  decimalText,
  FhirPath,
  FpQuantity,
  FpTemporal,
  type Item,
} from '@fhirjs/fhirpath';
import { fhirXmlToJson } from './fhir-xml.js';

/*
 * HL7's FHIRPath test suite (FHIR/fhir-test-cases r4/fhirpath/tests-fhir-r4.xml):
 * reading its cases, and running one.
 */

export interface SuiteOutput {
  type: string;
  value: string;
}

export interface SuiteCase {
  group: string;
  name: string;
  inputfile?: string;
  expression: string;
  /** An error is expected: syntax, semantic, execution */
  invalid?: string;
  predicate?: boolean;
  mode?: string;
  /** ordered="false": the outputs in any order */
  unordered?: boolean;
  /** context="Observation.effective": the expression runs on what this path gives */
  context?: string;
  /** contextType="Period|Timing": the types check() takes the context to have */
  contextType?: string[];
  /** skipStaticCheck="true": not checked statically */
  skipCheck?: boolean;
  outputs: SuiteOutput[];
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([A-Za-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    out[m[1]] = decode(m[2] ?? m[3]);
  return out;
}

/** The cases of the suite's XML file */
export function readSuite(file: string): SuiteCase[] {
  const xml = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const cases: SuiteCase[] = [];
  for (const g of xml.matchAll(/<group\b([^>]*)>([\s\S]*?)<\/group>/g)) {
    const group = attrs(g[1]).name ?? '';
    for (const t of g[2].matchAll(
      /<test\b([^>]*?)(?:\/>|>([\s\S]*?)<\/test>)/g,
    )) {
      const a = attrs(t[1]);
      const body = t[2] ?? '';
      const e = /<expression\b([^>]*)>([\s\S]*?)<\/expression>/.exec(body);
      if (!e) continue;
      const ea = attrs(e[1]);
      cases.push({
        group,
        name: a.name ?? `${group}#${cases.length}`,
        inputfile: a.inputfile,
        expression: decode(e[2]).trim(),
        invalid: ea.invalid ?? a.invalid,
        predicate:
          a.predicate === undefined ? undefined : a.predicate === 'true',
        mode: a.mode,
        unordered: a.ordered === 'false',
        context: a.context,
        contextType: a.contextType?.split('|'),
        skipCheck: a.skipStaticCheck === 'true',
        outputs: [
          ...body.matchAll(/<output\b([^>]*)>([\s\S]*?)<\/output>/g),
        ].map(o => ({ type: attrs(o[1]).type ?? '', value: decode(o[2]) })),
      });
    }
  }
  return cases;
}

/** Whether an item is the output the suite expects */
/** An item as a FHIRPath literal: @2014-01, @T10:30, 1.50, 1.5 'cm' */
function literalOf(item: Item): string {
  const v = item.v;
  if (v instanceof FpTemporal) return (v.kind === 'Time' ? '@T' : '@') + v.text;
  if (v instanceof FpQuantity) return `${v.text ?? v.value} '${v.unit}'`;
  if (typeof v === 'number' && decimalText(item)) return decimalText(item)!;
  return String(v);
}

function matches(item: Item, o: SuiteOutput): boolean {
  const v = item.v;
  const out = { ...o, value: o.value.trim() };
  switch (out.type) {
    case 'boolean':
      return v === (out.value === 'true');
    case 'integer':
    case 'decimal':
      // the digits written count: 1.58650000 is not 1.5865
      if (
        decimalText(item) &&
        out.value.includes('.') &&
        decimalText(item) !== out.value
      )
        return false;
      return typeof v === 'number' && v === Number(out.value);
    case 'date':
    case 'dateTime':
    case 'time': {
      const want = out.value.replace(/^@T?/, '');
      const text = v instanceof FpTemporal ? v.text : String(v);
      return text === want || text.replace(/^T/, '') === want;
    }
    case 'Quantity': {
      const q =
        v instanceof FpQuantity
          ? v
          : v && typeof v === 'object' && typeof v.value === 'number'
            ? new FpQuantity(v.value, v.code ?? v.unit)
            : undefined;
      if (!q) return false;
      const m = /^(-?[\d.]+)\s*(?:'([^']*)'|(\w+))?$/.exec(out.value);
      if (m && q.text && m[1].includes('.') && q.text !== m[1]) return false;
      return (
        !!m && q.value === Number(m[1]) && q.unit === (m[2] ?? m[3] ?? '1')
      );
    }
    default:
      // no type given: the value as FHIRPath writes it
      return literalOf(item) === out.value;
  }
}

export type SuiteResult = { ok: true } | { ok: false; reason: string };

/** Runs a case against an input resource */
/**
 * Runs a case against an input resource. Each case is also checked
 * statically (check()): a semantic error expected must be found there, and
 * a case without one must check clean.
 */
export function runCase(fp: FhirPath, c: SuiteCase, input: any): SuiteResult {
  const type: string | undefined = input?.resourceType;
  let items: Item[];
  let checkType: string | string[] | undefined = type;
  try {
    let focus: unknown = input;
    const options: { type?: string; resource?: unknown } = type ? { type } : {};
    if (c.context) {
      const ctx = fp.compile(c.context);
      focus = ctx.evaluateItems(input, options);
      checkType = c.contextType ?? ctx.typeOf({ type });
      options.type = undefined;
      options.resource = input;
    }
    // a case expecting another error (syntax, execution) may fail here too
    if (c.invalid === 'semantic' || (!c.invalid && !c.skipCheck)) {
      const issues = fp
        .compile(c.expression)
        .check({ type: checkType, vars: type ? { resource: type } : {} });
      if (c.invalid === 'semantic')
        return issues.length
          ? { ok: true }
          : {
              ok: false,
              reason: 'expected a semantic error, check() found none',
            };
      if (issues.length)
        return {
          ok: false,
          reason: `check(): ${issues.map(i => i.message).join('; ')}`,
        };
    }
    items = fp.compile(c.expression).evaluateItems(focus, options);
  } catch (e) {
    return c.invalid
      ? { ok: true }
      : { ok: false, reason: `error: ${(e as Error).message.split('\n')[0]}` };
  }
  if (c.invalid)
    return {
      ok: false,
      reason: `expected a ${c.invalid} error, got ${items.length} items`,
    };
  if (c.predicate) {
    const b = items.length > 0 && !(items.length === 1 && items[0].v === false);
    const want = c.outputs[0]?.value === 'true';
    return b === want
      ? { ok: true }
      : { ok: false, reason: `predicate ${b}, expected ${want}` };
  }
  const shown = () =>
    items
      .map(i =>
        i.v instanceof FpTemporal
          ? '@' + i.v.text
          : i.v instanceof FpQuantity
            ? String(i.v)
            : JSON.stringify(i.v),
      )
      .join(', ');
  if (items.length !== c.outputs.length)
    return {
      ok: false,
      reason: `got [${shown()}], expected [${c.outputs.map(o => o.value).join(', ')}]`,
    };
  const left = [...c.outputs];
  for (let i = 0; i < items.length; i++) {
    const k = c.unordered ? left.findIndex(o => matches(items[i], o)) : i;
    if (k >= 0 && matches(items[i], left[k])) {
      if (c.unordered) left.splice(k, 1);
      continue;
    }
    return {
      ok: false,
      reason: `got [${shown()}], expected [${c.outputs.map(o => `${o.type} ${o.value}`).join(', ')}]`,
    };
  }
  return { ok: true };
}

/**
 * The input a case reads: the suite's own file (JSON, or XML read with the
 * model), else the R4 example of that name
 */
export function loadInput(
  model: FhirModel,
  suiteDir: string,
  examplesDir: string,
  inputfile: string,
): any {
  const own = path.join(suiteDir, inputfile);
  if (fs.existsSync(own)) {
    const text = fs.readFileSync(own, 'utf8');
    return inputfile.endsWith('.xml')
      ? fhirXmlToJson(model, text)
      : parseFhirJson(text);
  }
  const base = inputfile.replace(/\.(xml|json)$/, '');
  for (const f of fs.readdirSync(examplesDir))
    if (f.toLowerCase() === `${base}.json`)
      return JSON.parse(fs.readFileSync(path.join(examplesDir, f), 'utf8'));
  return undefined;
}

/** Groups out of scope in both versions */
export const SKIPPED_GROUPS: Record<string, string> = {
  // section(), entry(), sameSubject() ...: an extension of the Java reference engine, not FHIRPath
  documentFunctions: 'functions of the Java reference engine only',
  // %terminologies.expand() ...: a terminology server
  TerminologyTests: 'a terminology server',
};

/** Known failures both versions' suites have */
export const KNOWN_FAILURES: Record<string, string> = {
  // the suite's results differ from the floor (low) and ceiling (high) the
  // other boundary cases follow: 0.0034.highBoundary(1) is 0.1 by that rule
  LowBoundaryDecimal15: 'suite expectation differs from the rounding rule',
  HighBoundaryDecimal15: 'suite expectation differs from the rounding rule',
  HighBoundaryDecimal16: 'suite expectation differs from the rounding rule',
  // the suite keeps hour precision's minutes at 00 but fills the seconds
  HighBoundaryDateTimeMillisecond1:
    'suite expectation fills seconds but not minutes',
  HighBoundaryDateTimeMillisecond3:
    'suite expectation fills seconds but not minutes',
};

/** Known failures of the suites before R5's (R4, R4B), on top of KNOWN_FAILURES */
export const KNOWN_BEFORE_R5: Record<string, string> = {
  // they drop the fraction of seconds added to a dateTime; R5's suite keeps it (.100)
  testPlusDate19: 'expectation changed in the R5 suite',
};

const SUITES = path.join(
  import.meta.dirname,
  '../../../../support/fhir-packages',
);

export interface SuiteSpec {
  version: 'r4' | 'r4b' | 'r5';
  model: FhirModel;
  /** The examples package, for inputs the suite folder does not have */
  examplesDir: string;
  /** Groups out of scope, and why */
  skippedGroups: Record<string, string>;
  /** Inputs out of scope (not FHIR resources of this version), and why */
  skippedInputs?: Record<string, string>;
  /** Cases known to fail, by name, and why */
  known: Record<string, string>;
  /** Cases in scope that must pass, at least */
  minPassing: number;
}

/**
 * The mocha suite of a version's HL7 FHIRPath tests: every case in scope
 * passes but the known ones, and a known one that passes comes off the list
 */
export function describeFhirPathSuite(spec: SuiteSpec) {
  describe(`HL7 FHIRPath test suite (${spec.version.toUpperCase()})`, function () {
    const at = fs.existsSync(SUITES)
      ? fs.readdirSync(SUITES).find(d => d.startsWith('fhirpath-tests@'))
      : undefined;
    const dir = at ? path.join(SUITES, at, spec.version) : '';
    const file = dir && path.join(dir, `tests-fhir-${spec.version}.xml`);
    let cases: SuiteCase[] = [];
    const inputs = new Map<string, any>();
    const input = (name: string) => {
      if (!inputs.has(name))
        inputs.set(name, loadInput(spec.model, dir, spec.examplesDir, name));
      return inputs.get(name);
    };

    before(function () {
      if (!file || !fs.existsSync(file)) return this.skip();
      cases = readSuite(file);
    });

    it('reads the suite and every input', function () {
      expect(cases.length).toBeGreaterThan(1100);
      const missing = [...new Set(cases.map(c => c.inputfile))].filter(
        f => f && !spec.skippedInputs?.[f] && input(f) === undefined,
      );
      expect(missing).toEqual([]);
    });

    it('passes every case in scope but the known ones', function () {
      this.timeout(120000);
      const fp = new FhirPath({ model: fhirPathModelOf(spec.model) });
      // mode="lenient/...": cases for the lenient reading
      const lenient = new FhirPath({
        model: fhirPathModelOf(spec.model),
        lenient: true,
      });
      const failed = new Map<string, string>();
      let ran = 0;
      for (const c of cases) {
        if (
          spec.skippedGroups[c.group] ||
          (c.inputfile && spec.skippedInputs?.[c.inputfile])
        )
          continue;
        ran++;
        const r = runCase(
          c.mode?.startsWith('lenient') ? lenient : fp,
          c,
          c.inputfile ? input(c.inputfile) : undefined,
        );
        if (!r.ok)
          failed.set(
            c.name,
            `${c.group}/${c.name}: ${c.expression}  =>  ${r.reason}`,
          );
      }
      console.log(
        `      ${ran - failed.size} of ${ran} cases in scope pass, ${failed.size} known failures`,
      );
      const unexpected = [...failed]
        .filter(([name]) => !spec.known[name])
        .map(([, text]) => text);
      expect(unexpected).toEqual([]);
      const fixed = Object.keys(spec.known).filter(name => !failed.has(name));
      expect(fixed).toEqual([]);
      expect(ran - failed.size).toBeGreaterThanOrEqual(spec.minPassing);
    });
  });
}
