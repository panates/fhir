/**
 * Generates the decorated classes of a FHIR version from its core package
 * (StructureDefinitions, ValueSets, CodeSystems) into
 * packages/<version>/src/ (the @fhirjs/<version> package).
 *
 *   node support/fetch-packages.mts          # once: download the packages
 *   node support/build-models.mts            # every type of R4
 *   node support/build-models.mts --version=R5
 *   node support/build-models.mts --types=Patient,Observation
 *                                            # those types and what they use
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { PACKAGES, packageDir } from './fetch-packages.mts';

const VERSION = (
  process.argv.find(a => a.startsWith('--version='))?.slice(10) || 'R4'
).toUpperCase();
if (!PACKAGES[VERSION])
  throw new Error(`No core package for ${VERSION}: ${Object.keys(PACKAGES)}`);
const CORE_PACKAGE = PACKAGES[VERSION];
const FHIR_VERSION = CORE_PACKAGE.version;
const CORE = '@fhirjs/core';
const FHIR_TYPE_EXT =
  'http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type';
const REGEX_EXT = 'http://hl7.org/fhir/StructureDefinition/regex';
const BINDING_NAME_EXT =
  'http://hl7.org/fhir/StructureDefinition/elementdefinition-bindingName';
const SYSTEM_PREFIX = 'http://hl7.org/fhirpath/System.';

const repoRoot = path.join(import.meta.dirname, '..');
const outDir = path.join(repoRoot, 'packages', VERSION.toLowerCase(), 'src');
const srcDir = packageDir(VERSION);

/* ------------------------------------------------------------------ */
/* Source                                                             */
/* ------------------------------------------------------------------ */

interface SD {
  url: string;
  name: string;
  type: string;
  kind: string;
  abstract: boolean;
  derivation?: string;
  baseDefinition?: string;
  description?: string;
  snapshot: { element: ED[] };
}

interface ED {
  path: string;
  short?: string;
  min: number;
  max: string;
  base?: { path: string };
  type?: { code: string; targetProfile?: string[]; extension?: any[] }[];
  contentReference?: string;
  binding?: { strength: string; valueSet?: string; extension?: any[] };
  constraint?: {
    key: string;
    severity: string;
    human: string;
    expression?: string;
    source?: string;
  }[];
  isSummary?: boolean;
  isModifier?: boolean;
  mustSupport?: boolean;
}

const sds = new Map<string, SD>();
const valueSets = new Map<string, any>();
const codeSystems = new Map<string, any>();
const searchParams: any[] = [];

for (const file of readdirSync(srcDir)) {
  if (!file.endsWith('.json')) continue;
  if (
    !file.startsWith('StructureDefinition-') &&
    !file.startsWith('ValueSet-') &&
    !file.startsWith('CodeSystem-') &&
    !file.startsWith('SearchParameter-')
  )
    continue;
  const res = JSON.parse(readFileSync(path.join(srcDir, file), 'utf8'));
  if (res.resourceType === 'ValueSet') valueSets.set(res.url, res);
  else if (res.resourceType === 'CodeSystem') codeSystems.set(res.url, res);
  else if (res.resourceType === 'SearchParameter') searchParams.push(res);
  else if (
    res.resourceType === 'StructureDefinition' &&
    ['primitive-type', 'complex-type', 'resource'].includes(res.kind) &&
    res.derivation !== 'constraint'
  )
    sds.set(res.type, res);
}

/* ------------------------------------------------------------------ */
/* Intermediate model                                                 */
/* ------------------------------------------------------------------ */

type JsonKind = 'string' | 'number' | 'boolean';

interface GenElementType {
  code: string; // FHIR type name the decorator refers to
  property: string; // property name
  targets?: string[];
}

interface GenElement {
  name: string; // 'deceased[x]'
  ed: ED;
  types: GenElementType[];
  union?: string; // TS union of a required binding
}

interface GenClass {
  className: string;
  typeName: string; // name in the model: 'Patient', 'PatientContact', 'string'
  kind: 'primitive-type' | 'complex-type' | 'backbone' | 'resource';
  base?: string; // class name of the base
  sd: SD;
  path: string;
  file: string; // relative to outDir, without extension
  elements: GenElement[];
  constraints: NonNullable<ED['constraint']>;
  short?: string;
}

const classes = new Map<string, GenClass>(); // by type name
const unions = new Map<string, { url: string; codes: string[] }>();

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const pathToName = (p: string) => p.split('.').map(cap).join('');
const kebab = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();

function primitiveJson(name: string): JsonKind {
  if (name === 'boolean') return 'boolean';
  // integer64 (R5) is a JSON string: a number would lose digits
  if (['integer', 'decimal', 'unsignedInt', 'positiveInt'].includes(name))
    return 'number';
  return 'string';
}

function isPrimitive(code: string): boolean {
  return sds.get(code)?.kind === 'primitive-type';
}

function primitiveClassName(name: string) {
  return cap(name) + 'Type';
}

/** Codes of a value set, when the package can list them all */
/** Codes of a value set by code system, when the package can list them all */
type VSEntries = Record<string, string[]>;
const vsCache = new Map<string, VSEntries | null>();

function valueSetEntries(
  url: string,
  seen = new Set<string>(),
): VSEntries | undefined {
  url = url.split('|')[0];
  if (vsCache.has(url)) return vsCache.get(url) ?? undefined;
  if (seen.has(url)) return;
  seen.add(url);
  const result = resolveValueSet(url, seen);
  vsCache.set(url, result ?? null);
  return result;
}

function resolveValueSet(
  url: string,
  seen: Set<string>,
): VSEntries | undefined {
  const vs = valueSets.get(url);
  if (!vs) return;
  const out: Record<string, Set<string>> = {};
  const add = (system: string | undefined, code: string) =>
    (out[system ?? ''] ||= new Set()).add(code);
  if (vs.expansion?.contains) {
    const walk = (items: any[]) => {
      for (const c of items) {
        if (c.code && !c.abstract) add(c.system, c.code);
        if (c.contains) walk(c.contains);
      }
    };
    walk(vs.expansion.contains);
  } else {
    if (!vs.compose?.include) return;
    const part = (inc: any): VSEntries | undefined => {
      if (inc.filter?.length) return;
      const r: Record<string, string[]> = {};
      if (inc.system) {
        if (inc.concept) r[inc.system] = inc.concept.map((c: any) => c.code);
        else {
          const cs = codeSystems.get(inc.system);
          if (!cs?.concept || cs.content !== 'complete') return;
          const codes: string[] = [];
          const walk = (items: any[]) => {
            for (const c of items) {
              const abstract = c.property?.some(
                (p: any) =>
                  (p.code === 'abstract' || p.code === 'notSelectable') &&
                  p.valueBoolean,
              );
              if (!abstract) codes.push(c.code);
              if (c.concept) walk(c.concept);
            }
          };
          walk(cs.concept);
          r[inc.system] = codes;
        }
      }
      // A nested value set narrows (intersection) or, alone, is the content
      for (const ref of inc.valueSet || []) {
        const nested = valueSetEntries(ref, seen);
        if (!nested) return;
        if (!inc.system) Object.assign(r, nested);
        else
          r[inc.system] = r[inc.system].filter(c =>
            nested[inc.system]?.includes(c),
          );
      }
      return r;
    };
    for (const inc of vs.compose.include) {
      const r = part(inc);
      if (!r) return;
      for (const [system, codes] of Object.entries(r))
        for (const c of codes) add(system, c);
    }
    for (const exc of vs.compose.exclude || []) {
      const r = part(exc);
      if (!r) return;
      for (const [system, codes] of Object.entries(r))
        for (const c of codes) out[system]?.delete(c);
    }
  }
  const entries: VSEntries = {};
  for (const [system, codes] of Object.entries(out))
    if (codes.size) entries[system] = [...codes];
  return Object.keys(entries).length ? entries : undefined;
}

function valueSetCodes(url: string): string[] | undefined {
  const e = valueSetEntries(url);
  return e ? [...new Set(Object.values(e).flat())] : undefined;
}

/** Value sets of required bindings the package can list: url -> entries */
const requiredValueSets = new Map<string, VSEntries>();
/** Required bindings whose value set cannot be listed, by url: count */
const unresolvedRequired = new Map<string, number>();

function noteRequiredBinding(ed: ED) {
  const b = ed.binding;
  if (b?.strength !== 'required' || !b.valueSet) return;
  const url = b.valueSet.split('|')[0];
  const e = valueSetEntries(url);
  if (e) requiredValueSets.set(url, e);
  else unresolvedRequired.set(url, (unresolvedRequired.get(url) || 0) + 1);
}

function unionFor(ed: ED): string | undefined {
  const b = ed.binding;
  if (b?.strength !== 'required' || !b.valueSet) return;
  if (ed.type?.length !== 1 || ed.type[0].code !== 'code') return;
  const codes = valueSetCodes(b.valueSet);
  if (!codes) return;
  const url = b.valueSet.split('|')[0];
  const fromUrl = pathToName(
    url
      .split('/')
      .pop()!
      .replace(/[^A-Za-z0-9]+/g, '.'),
  );
  let name = (
    b.extension?.find(x => x.url === BINDING_NAME_EXT)?.valueString || ''
  ).replace(/[^A-Za-z0-9_]/g, '');
  // a binding name that is empty or not an identifier: the value set's
  if (!/^[A-Za-z]/.test(name)) name = fromUrl;
  if (sds.has(name)) name += 'Code';
  const existing = unions.get(name);
  if (existing && existing.url !== url) {
    name = fromUrl;
    if (sds.has(name)) name += 'Code';
  }
  const prev = unions.get(name);
  if (prev && prev.url !== url) return; // give up: plain string
  unions.set(name, { url, codes });
  return name;
}

function elementTypes(sd: SD, ed: ED, name: string): GenElementType[] {
  if (ed.contentReference) {
    const ref = ed.contentReference.replace(/^.*#/, '');
    return [{ code: pathToName(ref), property: name }];
  }
  const choice = name.endsWith('[x]');
  const stem = name.slice(0, -3);
  return (ed.type || []).map(t => {
    let code = t.code;
    if (code.startsWith(SYSTEM_PREFIX)) {
      code =
        t.extension?.find(x => x.url === FHIR_TYPE_EXT)?.valueUrl || 'string';
      // R4B alone types Element.id as id; its own data (ElementDefinition ids
      // like "Measure.subject[x]") does not fit, and R4 and R5 say string
      if (ed.path === 'Element.id' && code === 'id') code = 'string';
    } else if (
      (code === 'BackboneElement' || code === 'Element') &&
      ed.path.includes('.')
    )
      code = pathToName(ed.path);
    const targets = t.targetProfile?.map(u => u.split('/').pop()!);
    return {
      code,
      property: choice ? stem + cap(code) : name,
      targets: targets?.length ? targets : undefined,
    };
  });
}

/** The types a StructureDefinition derives from, following baseDefinition */
function ancestorsOf(sd: SD): Set<string> {
  const out = new Set<string>();
  for (let b = sd.baseDefinition; b;) {
    const name = b.split('/').pop()!;
    out.add(name);
    b = sds.get(name)?.baseDefinition;
  }
  return out;
}

function addClass(
  sd: SD,
  p: string,
  kind: GenClass['kind'],
  base: string | undefined,
  file: string,
) {
  const elements: GenElement[] = [];
  const all = sd.snapshot.element;
  const self = all.find(e => e.path === p)!;
  const depth = p.split('.').length;
  // The types this class derives from: a backbone's base (BackboneElement,
  // Element) and its chain; the StructureDefinition's chain otherwise
  const baseSd = kind === 'backbone' && base ? sds.get(base) : undefined;
  const inheritedFrom =
    kind === 'backbone' && base
      ? new Set([base, ...(baseSd ? ancestorsOf(baseSd) : [])])
      : ancestorsOf(sd);
  const ownConstraints = (ed: ED) =>
    (ed.constraint || []).filter(c => !c.source || c.source === sd.url);
  for (const ed of all) {
    const segs = ed.path.split('.');
    if (segs.length !== depth + 1 || !ed.path.startsWith(p + '.')) continue;
    // inherited from a type in the class's base chain; an element whose base
    // is a type the class does not extend (R5's MetadataResource takes
    // CanonicalResource's elements without extending it) is its own
    if (!ed.base || inheritedFrom.has(ed.base.path.split('.')[0])) continue;
    const name = segs[depth];
    const types = elementTypes(sd, ed, name);
    elements.push({ name, ed, types, union: unionFor(ed) });
    noteRequiredBinding(ed);
    for (const t of types)
      if (t.code === pathToName(ed.path) && !ed.contentReference)
        addClass(sd, ed.path, 'backbone', ed.type![0].code, file);
  }
  const typeName = kind === 'backbone' ? pathToName(p) : sd.type;
  classes.set(typeName, {
    className:
      kind === 'primitive-type' ? primitiveClassName(sd.type) : typeName,
    typeName,
    kind,
    base,
    sd,
    path: p,
    file,
    elements,
    constraints: ownConstraints(self),
    short: self.short,
  });
}

for (const sd of sds.values()) {
  const base = sd.baseDefinition?.split('/').pop();
  if (sd.kind === 'primitive-type') {
    addClass(sd, sd.type, 'primitive-type', undefined, 'primitives');
    classes.get(sd.type)!.elements = []; // its value is the class itself
    continue;
  }
  const dir = sd.kind === 'resource' ? 'resources' : 'datatypes';
  addClass(
    sd,
    sd.type,
    sd.kind as GenClass['kind'],
    base,
    `${dir}/${kebab(sd.type)}`,
  );
}

/* ------------------------------------------------------------------ */
/* Selection (--types)                                                */
/* ------------------------------------------------------------------ */

const typesArg = process.argv.find(a => a.startsWith('--types='));
let selected: Set<string>;
if (typesArg) {
  selected = new Set();
  const visit = (name: string) => {
    if (selected.has(name)) return;
    const c = classes.get(name);
    if (!c) throw new Error(`Unknown type ${name}`);
    selected.add(name);
    if (c.base)
      visit(
        c.kind === 'backbone' ? c.base : c.sd.baseDefinition!.split('/').pop()!,
      );
    for (const el of c.elements) for (const t of el.types) visit(t.code);
    // the backbones of the same StructureDefinition live in the same file
    for (const o of classes.values())
      if (o.file === c.file && o.kind === 'backbone') visit(o.typeName);
  };
  for (const n of typesArg.slice(8).split(',')) visit(n.trim());
} else selected = new Set(classes.keys());

/* ------------------------------------------------------------------ */
/* Output                                                             */
/* ------------------------------------------------------------------ */

function lit(v: unknown): string {
  if (typeof v === 'string')
    return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`;
  if (Array.isArray(v)) return `[${v.map(lit).join(', ')}]`;
  if (v && typeof v === 'object')
    return `{ ${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(
        ([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : lit(k)}: ${lit(x)}`,
      )
      .join(', ')} }`;
  return String(v);
}

function doc(text: string | undefined, indent = ''): string {
  if (!text) return '';
  return `${indent}/** ${text.replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim()} */\n`;
}

function tsTypeOf(t: GenElementType, el: GenElement): string {
  if (el.union) return el.union;
  if (isPrimitive(t.code)) {
    const j = primitiveJson(t.code);
    return j;
  }
  return classes.get(t.code)!.className;
}

function constraintLit(c: NonNullable<ED['constraint']>[number]) {
  return lit({
    key: c.key,
    severity: c.severity,
    human: c.human,
    expression: c.expression,
  });
}

function relImport(fromFile: string, toFile: string): string {
  let r = path.relative(path.dirname(fromFile), toFile);
  if (!r.startsWith('.')) r = './' + r;
  return r + '.js';
}

const files = new Map<string, GenClass[]>();
for (const name of selected) {
  const c = classes.get(name)!;
  (files.get(c.file) || files.set(c.file, []).get(c.file)!).push(c);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(outDir, 'datatypes'), { recursive: true });
mkdirSync(path.join(outDir, 'resources'), { recursive: true });

const HEADER = `/* Generated by support/build-models.mts from ${CORE_PACKAGE.name}#${FHIR_VERSION}. Do not edit. */\n`;

for (const [file, list] of files) {
  // A base must be declared before the classes extending it
  const order: GenClass[] = [];
  const placed = new Set<string>();
  const place = (c: GenClass) => {
    if (placed.has(c.typeName)) return;
    const local = list.find(o => o.className === c.base);
    if (local) place(local);
    placed.add(c.typeName);
    order.push(c);
  };
  // Root type first, then its backbones in definition order
  list.forEach(place);

  const valueImports = new Map<string, Set<string>>(); // file -> names
  const typeImports = new Map<string, Set<string>>();
  const coreValues = new Set<string>();
  const coreTypes = new Set<string>();
  const addImport = (m: Map<string, Set<string>>, f: string, n: string) => {
    if (f === file) return;
    (m.get(f) || m.set(f, new Set()).get(f)!).add(n);
  };

  const body: string[] = [];
  for (const c of order) {
    if (c.kind === 'primitive-type') {
      coreValues.add('FhirPrimitiveType');
      const value = c.sd.snapshot.element.find(
        e => e.path === c.sd.type + '.value',
      );
      const regex = value?.type?.[0]?.extension?.find(
        x => x.url === REGEX_EXT,
      )?.valueString;
      body.push(
        doc(c.sd.description) +
          `@FhirPrimitiveType(${lit({ name: c.sd.type, url: c.sd.url, regex, json: primitiveJson(c.sd.type) })})\n` +
          `export class ${c.className} {}\n`,
      );
      continue;
    }

    const decoName =
      c.kind === 'resource'
        ? 'FhirResource'
        : c.kind === 'backbone'
          ? 'FhirBackboneType'
          : 'FhirComplexType';
    coreValues.add(decoName);
    const typeOpts =
      c.kind === 'backbone'
        ? { path: c.path }
        : { url: c.sd.url, abstract: c.sd.abstract || undefined };
    const lines: string[] = [];
    lines.push(doc(c.kind === 'backbone' ? c.short : c.sd.description));
    lines.push(`@${decoName}(${lit(typeOpts)})\n`);
    for (const k of c.constraints) {
      coreValues.add('FhirConstraint');
      lines.push(`@FhirConstraint(${constraintLit(k)})\n`);
    }
    if (c.base) {
      const baseClass = [...classes.values()].find(
        o => o.className === c.base,
      )!;
      addImport(valueImports, baseClass.file, baseClass.className);
    }
    lines.push(
      `export class ${c.className}${c.base ? ` extends ${c.base}` : ''} {\n`,
    );

    // Constructor
    coreTypes.add('FhirInit');
    if (c.typeName === 'Resource') {
      coreValues.add('resourceTypeOf');
      lines.push(
        `  declare readonly resourceType: string;\n\n` +
          `  constructor(init?: FhirInit<${c.className}>) {\n` +
          (c.base ? `    super();\n` : '') +
          `    const resourceType = resourceTypeOf(new.target);\n` +
          `    if (resourceType) (this as { resourceType: string }).resourceType = resourceType;\n` +
          `    if (init) Object.assign(this, init);\n  }\n`,
      );
    } else if (!c.base) {
      lines.push(
        `  constructor(init?: FhirInit<${c.className}>) {\n    if (init) Object.assign(this, init);\n  }\n`,
      );
    } else {
      if (c.kind === 'resource' && !c.sd.abstract)
        lines.push(`  declare readonly resourceType: '${c.typeName}';\n\n`);
      lines.push(
        `  constructor(init?: FhirInit<${c.className}>) {\n    super(init);\n  }\n`,
      );
    }

    for (const el of c.elements) {
      const ed = el.ed;
      const isArray = ed.max === '*' || Number(ed.max) > 1;
      const choice = el.name.endsWith('[x]');
      const ownConstraints = (ed.constraint || []).filter(
        k => !k.source || k.source === c.sd.url,
      );
      const isBackboneEl =
        el.types.length === 1 &&
        classes.get(el.types[0].code)?.kind === 'backbone' &&
        !ed.contentReference;
      for (const t of el.types) {
        coreValues.add('FhirElement');
        const opts: Record<string, unknown> = { type: t.code };
        if (t.targets) opts.targets = t.targets;
        if (ed.min) opts.min = ed.min;
        if (ed.max !== '1') opts.max = ed.max === '*' ? '*' : Number(ed.max);
        if (choice) opts.choice = el.name;
        if (ed.binding?.valueSet)
          opts.binding = {
            strength: ed.binding.strength,
            valueSet: ed.binding.valueSet,
          };
        if (ed.isSummary) opts.summary = true;
        if (ed.isModifier) opts.modifier = true;
        if (ed.mustSupport) opts.mustSupport = true;
        if (ed.type?.some(x => x.code.startsWith(SYSTEM_PREFIX)))
          opts.noExtension = true;

        let ts = tsTypeOf(t, el);
        const target = classes.get(t.code)!;
        if (el.union) addImport(typeImports, 'value-sets', el.union);
        else if (!isPrimitive(t.code))
          addImport(typeImports, target.file, target.className);
        if (isArray) ts = ts.includes('|') ? `(${ts})[]` : ts + '[]';
        const optional = choice || !ed.min ? '?' : '';

        lines.push('\n' + doc(ed.short, '  '));
        lines.push(`  @FhirElement(${lit(opts)})\n`);
        // constraints of a backbone element go on its class
        if (!isBackboneEl)
          for (const k of ownConstraints) {
            coreValues.add('FhirConstraint');
            lines.push(`  @FhirConstraint(${constraintLit(k)})\n`);
          }
        lines.push(`  declare ${t.property}${optional}: ${ts};\n`);

        // primitive extension sibling: _birthDate
        const sourceType = ed.type?.find(
          x => t.code === x.code || x.code.startsWith(SYSTEM_PREFIX),
        );
        const isSystem = sourceType?.code.startsWith(SYSTEM_PREFIX);
        if (isPrimitive(t.code) && !isSystem && t.code !== 'xhtml') {
          const elementClass = classes.get('Element')!;
          addImport(typeImports, elementClass.file, 'Element');
          lines.push(
            `  declare _${t.property}?: ${isArray ? '(Element | null)[]' : 'Element'};\n`,
          );
        }
      }
    }
    lines.push('}\n');
    body.push(lines.join(''));
  }

  const imports: string[] = [];
  if (coreValues.size)
    imports.push(
      `import { ${[...coreValues].sort().join(', ')} } from '${CORE}';`,
    );
  if (coreTypes.size)
    imports.push(
      `import type { ${[...coreTypes].sort().join(', ')} } from '${CORE}';`,
    );
  const target = path.join(outDir, file);
  for (const [f, names] of valueImports) {
    imports.push(
      `import { ${[...names].sort().join(', ')} } from '${relImport(target, path.join(outDir, f))}';`,
    );
    const t = typeImports.get(f);
    if (t) for (const n of names) t.delete(n);
  }
  for (const [f, names] of typeImports)
    if (names.size)
      imports.push(
        `import type { ${[...names].sort().join(', ')} } from '${relImport(target, path.join(outDir, f))}';`,
      );

  writeFileSync(
    target + '.ts',
    HEADER + imports.join('\n') + '\n\n' + body.join('\n'),
  );
}

// Value sets of required bindings
{
  const out = [HEADER];
  for (const [name, { url, codes }] of [...unions].sort()) {
    out.push(
      `/** ${url} */\nexport type ${name} = ${codes.map(c => lit(c)).join(' | ')};\n`,
    );
  }
  writeFileSync(path.join(outDir, 'value-sets.ts'), out.join('\n'));
}

// Codes of the value sets of required bindings, for the codec
{
  const out = [HEADER];
  out.push(
    `/**\n * Codes of the value sets of required bindings, by canonical URL: code system -> codes.\n * Value sets the package cannot list (external code systems, filters) are absent.\n */`,
  );
  out.push(
    `export const ${VERSION}_VALUE_SETS: Record<string, Record<string, string[]>> = {`,
  );
  for (const [url, entries] of [...requiredValueSets].sort((a, b) =>
    a[0].localeCompare(b[0]),
  ))
    out.push(`  ${lit(url)}: ${lit(entries)},`);
  out.push('};\n');
  writeFileSync(path.join(outDir, 'value-set-data.ts'), out.join('\n'));
}

// Search parameters, for a server
const searchParamNotes: string[] = [];
{
  // the base types of the classes generated, and Resource and DomainResource
  const bases = new Set(
    [...selected].filter(n => classes.get(n)!.kind === 'resource'),
  );
  const byKey = new Map<string, any>(); // base|code -> SearchParameter
  for (const sp of searchParams.sort((a, b) => a.url.localeCompare(b.url))) {
    // the package's examples (SearchParameter/example) are not definitions
    if (/^example/.test(sp.id)) continue;
    if (!sp.base?.length) {
      searchParamNotes.push(`${sp.id}: no base`);
      continue;
    }
    for (const base of sp.base) {
      if (!bases.has(base)) continue;
      const key = `${base}|${sp.code}`;
      const prev = byKey.get(key);
      // two for one code: the one named after its base (Resource-filter, not filter)
      if (prev && !String(sp.id).startsWith(`${base}-`)) {
        searchParamNotes.push(`${sp.id}: ${key} is ${prev.id}`);
        continue;
      }
      if (prev) searchParamNotes.push(`${prev.id}: ${key} is ${sp.id}`);
      byKey.set(key, sp);
    }
  }
  const kept = [...new Set(byKey.values())].sort((a, b) =>
    a.url.localeCompare(b.url),
  );
  const out = [HEADER];
  out.push(`import type { FhirSearchParameter } from '${CORE}';\n`);
  out.push(
    `/** The search parameters of ${VERSION}, from the SearchParameter resources of ${CORE_PACKAGE.name} */`,
  );
  out.push(
    `export const ${VERSION}_SEARCH_PARAMETERS: FhirSearchParameter[] = [`,
  );
  for (const sp of kept) {
    const p: Record<string, unknown> = {
      url: sp.url,
      code: sp.code,
      type: sp.type,
      base: sp.base.filter((b: string) => bases.has(b)),
    };
    if (sp.expression) p.expression = sp.expression;
    if (sp.target?.length) p.target = sp.target;
    if (sp.component?.length)
      p.component = sp.component.map((c: any) => ({
        definition: c.definition,
        expression: c.expression,
      }));
    out.push(`  ${lit(p)},`);
  }
  out.push('];\n');
  writeFileSync(path.join(outDir, 'search-parameters.ts'), out.join('\n'));
  searchParamNotes.unshift(`${kept.length} search parameters`);
}

// Index
{
  const sorted = [...files.keys()].sort();
  const all = [...selected].map(n => classes.get(n)!.className).sort();
  const out = [HEADER];
  out.push(`import { FhirModel } from '${CORE}';`);
  for (const f of sorted)
    out.push(
      `import { ${files
        .get(f)!
        .map(c => c.className)
        .sort()
        .join(', ')} } from './${f}.js';`,
    );
  out.push('');
  for (const f of sorted) out.push(`export * from './${f}.js';`);
  out.push(`export type * from './value-sets.js';`);
  out.push(`import { ${VERSION}_VALUE_SETS } from './value-set-data.js';`);
  out.push(`export { ${VERSION}_VALUE_SETS };`);
  out.push(
    `import { ${VERSION}_SEARCH_PARAMETERS } from './search-parameters.js';`,
  );
  out.push(`export { ${VERSION}_SEARCH_PARAMETERS };\n`);
  out.push(
    `/** Every type of ${VERSION} */\nexport const ${VERSION}_TYPES: Function[] = [\n  ${all.join(',\n  ')},\n];\n`,
  );
  out.push(
    `/** The ${VERSION} model */\nexport const ${VERSION.toLowerCase()}Model = new FhirModel('${FHIR_VERSION}', ${VERSION}_TYPES, {\n  valueSets: ${VERSION}_VALUE_SETS,\n  searchParameters: ${VERSION}_SEARCH_PARAMETERS,\n});\n`,
  );
  writeFileSync(path.join(outDir, 'index.ts'), out.join('\n'));
}

execFileSync(path.join(repoRoot, 'node_modules/.bin/prettier'), [
  '--write',
  '--log-level=warn',
  outDir,
]);

const counts: Record<string, number> = {};
for (const n of selected) {
  const k = classes.get(n)!.kind;
  counts[k] = (counts[k] || 0) + 1;
}
console.log(
  `required bindings: ${requiredValueSets.size} value sets listed, ${unresolvedRequired.size} not listable:`,
  [...unresolvedRequired.keys()].map(u => u.split('/').pop()).join(', '),
);
console.log(
  `${VERSION}: ${selected.size} classes in ${files.size} files`,
  counts,
  `${unions.size} value set types`,
);
console.log(`search parameters: ${searchParamNotes.join('; ')}`);
