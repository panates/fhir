import fs from 'node:fs';
import path from 'node:path';
import { readTgz } from './tgz.js';

/** The resource types a package is read for */
const CONFORMANCE = new Set([
  'StructureDefinition',
  'ValueSet',
  'CodeSystem',
  'SearchParameter',
]);

/** A conformance resource of a package, as its .index.json lists it */
export interface FhirPackageEntry {
  /** File name in the package folder */
  file: string;
  resourceType: string;
  id?: string;
  url?: string;
  version?: string;
  /** For a StructureDefinition: the type it defines or constrains */
  type?: string;
}

/**
 * A FHIR package (an implementation guide, as published at packages.fhir.org):
 * its name, version, dependencies and conformance resources
 * (StructureDefinitions, ValueSets, CodeSystems). Examples are not read.
 *
 * Read from its `.index.json`, a package parses a resource only when it is
 * asked for: by type (all StructureDefinitions) or by URL (one value set).
 * A big terminology package (VSAC: 14,000 value sets) costs little until
 * its value sets are used.
 */
export class FhirPackage {
  private readonly _entries: FhirPackageEntry[] = [];
  private readonly _byUrl = new Map<string, FhirPackageEntry>();
  private readonly _parsed = new Map<string, any>();
  private readonly _read?: (file: string) => string;

  /**
   * @param resources the resources themselves, or the package's index and a
   *   function reading a file of it
   */
  constructor(
    readonly name: string,
    readonly version: string,
    /** FHIR versions the package is for: ['4.0.1'] */
    readonly fhirVersions: string[],
    resources:
      | Iterable<any>
      | { entries: FhirPackageEntry[]; read: (file: string) => string },
    /** Packages it depends on: name -> version */
    readonly dependencies: Record<string, string> = {},
  ) {
    if (Symbol.iterator in Object(resources)) {
      let i = 0;
      for (const r of resources as Iterable<any>) {
        if (!r || !CONFORMANCE.has(r.resourceType)) continue;
        const entry: FhirPackageEntry = {
          file: `#${i++}`,
          resourceType: r.resourceType,
          id: r.id,
          url: r.url,
          version: r.version,
          type: r.type,
        };
        this._parsed.set(entry.file, r);
        this._add(entry);
      }
    } else {
      const src = resources as {
        entries: FhirPackageEntry[];
        read: (file: string) => string;
      };
      this._read = src.read;
      for (const e of src.entries)
        if (CONFORMANCE.has(e.resourceType)) this._add(e);
    }
  }

  private _add(entry: FhirPackageEntry) {
    this._entries.push(entry);
    if (entry.url) {
      const key = entry.resourceType + '|' + entry.url;
      if (!this._byUrl.has(key)) this._byUrl.set(key, entry);
    }
  }

  /** 'hl7.fhir.us.core#6.1.0' */
  get id(): string {
    return `${this.name}#${this.version}`;
  }

  /** The index entries of a resource type: no file is read */
  entriesOf(resourceType: string): FhirPackageEntry[] {
    return this._entries.filter(e => e.resourceType === resourceType);
  }

  /** The resource of an index entry (read and parsed once) */
  resourceOf(entry: FhirPackageEntry): any {
    return this._load(entry);
  }

  /** Every resource of a type (each read and parsed once) */
  resourcesOf(resourceType: string): any[] {
    const out: any[] = [];
    for (const e of this._entries) {
      if (e.resourceType !== resourceType) continue;
      const r = this._load(e);
      if (r) out.push(r);
    }
    return out;
  }

  /** A resource by its canonical URL (a |version suffix is ignored) */
  findResource(resourceType: string, url: string): any {
    const bar = url.indexOf('|');
    if (bar >= 0) url = url.slice(0, bar);
    const e = this._byUrl.get(resourceType + '|' + url);
    return e ? this._load(e) : undefined;
  }

  /** How many resources have been parsed so far */
  get parsedCount(): number {
    return this._parsed.size;
  }

  private _load(e: FhirPackageEntry): any {
    let r = this._parsed.get(e.file);
    if (r === undefined && this._read) {
      try {
        r = JSON.parse(this._read(e.file));
      } catch {
        r = null; // a broken file is skipped
      }
      if (r && r.resourceType !== e.resourceType) r = null;
      this._parsed.set(e.file, r);
    }
    return r || undefined;
  }

  /**
   * Reads an extracted package: the `package` folder of the .tgz. With its
   * `.index.json`, only the index is read now; without one, every file.
   */
  static fromDirectory(dir: string): FhirPackage {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
    );
    const indexFile = path.join(dir, '.index.json');
    const read = (file: string) =>
      fs.readFileSync(path.join(dir, file), 'utf8');
    if (fs.existsSync(indexFile)) {
      const entries = entriesOfIndex(
        JSON.parse(fs.readFileSync(indexFile, 'utf8')),
      );
      if (entries) return FhirPackage._create(manifest, { entries, read });
    }
    const resources: any[] = [];
    for (const file of fs.readdirSync(dir)) {
      if (
        !file.endsWith('.json') ||
        file === 'package.json' ||
        file.startsWith('.')
      )
        continue;
      const res = parseResource(read(file));
      if (res) resources.push(res);
    }
    return FhirPackage._create(manifest, resources);
  }

  /** Reads a package from its .tgz, in memory; resources are parsed when asked for */
  static fromTgz(data: Uint8Array): FhirPackage {
    const files = readTgz(data);
    const manifest = files.get('package/package.json');
    if (!manifest)
      throw new Error('Not a FHIR package: no package/package.json');
    const index = files.get('package/.index.json');
    const read = (file: string) =>
      files.get('package/' + file)!.toString('utf8');
    const entries = index
      ? entriesOfIndex(JSON.parse(index.toString('utf8')))
      : undefined;
    if (entries)
      return FhirPackage._create(JSON.parse(manifest.toString('utf8')), {
        entries: entries.filter(e => files.has('package/' + e.file)),
        read,
      });
    const resources: any[] = [];
    for (const [name, content] of files) {
      // resources are files directly in package/ (not examples, not other/)
      if (
        !/^package\/[^/]+\.json$/.test(name) ||
        name === 'package/package.json'
      )
        continue;
      if (name.startsWith('package/.')) continue;
      const res = parseResource(content.toString('utf8'));
      if (res) resources.push(res);
    }
    return FhirPackage._create(
      JSON.parse(manifest.toString('utf8')),
      resources,
    );
  }

  private static _create(
    manifest: any,
    resources: ConstructorParameters<typeof FhirPackage>[3],
  ): FhirPackage {
    return new FhirPackage(
      manifest.name,
      manifest.version,
      manifest.fhirVersions || manifest['fhir-version-list'] || [],
      resources,
      manifest.dependencies || {},
    );
  }
}

/** The entries of a package's .index.json (index-version 1 or 2) */
function entriesOfIndex(index: any): FhirPackageEntry[] | undefined {
  if (!Array.isArray(index?.files)) return;
  const out: FhirPackageEntry[] = [];
  for (const f of index.files) {
    if (typeof f?.filename !== 'string' || typeof f.resourceType !== 'string')
      continue;
    // a name with a folder or ../ is not a file of the package folder
    if (f.filename.includes('/') || f.filename.includes('\\')) continue;
    out.push({
      file: f.filename,
      resourceType: f.resourceType,
      id: f.id,
      url: f.url,
      version: f.version,
      type: f.type,
    });
  }
  return out;
}

/** A conformance resource from JSON text; others (and broken files) are skipped */
function parseResource(text: string): any {
  // cheap test before parsing: most files of a big package are other resources
  const m = /"resourceType"\s*:\s*"([A-Za-z]+)"/.exec(text.slice(0, 512));
  if (m && !CONFORMANCE.has(m[1])) return;
  try {
    const res = JSON.parse(text);
    return CONFORMANCE.has(res?.resourceType) ? res : undefined;
  } catch {
    return;
  }
}
