import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FhirPackage } from './fhir-package.js';
import { readTgz } from './tgz.js';

export interface FhirPackageCacheOptions {
  /**
   * The cache folder: `<name>#<version>/package` per package. Default
   * ~/.fhir/packages, the folder HAPI, Firely and the IG Publisher share.
   */
  dir?: string;
  /** Download a package missing from the cache (default false) */
  download?: boolean;
  /** Where to download from (default https://packages.fhir.org) */
  registry?: string;
  /**
   * Packages left out when resolving dependencies; default: the examples
   * and expansions packages of FHIR versions. The core package
   * (hl7.fhir.r4.core) is kept: its profiles, extension definitions and
   * value sets load as data on top of the generated model.
   */
  skip?: (name: string) => boolean;
}

export interface FhirPackageResolution {
  /** Dependencies first, then the package asked for */
  packages: FhirPackage[];
  /** Packages left out (examples and expansions of FHIR versions) */
  skipped: string[];
  /** A package needed in two versions: the first one met is used */
  conflicts: string[];
}

const NOT_NEEDED = /^hl7\.fhir\.r[0-9]+b?\.(expansions|examples)$/;
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

/**
 * Reads FHIR packages from a local cache, downloading missing ones from the
 * registry when allowed, and resolves their dependencies.
 */
export class FhirPackageCache {
  readonly dir: string;
  readonly download: boolean;
  readonly registry: string;
  private readonly _skip: (name: string) => boolean;
  private readonly _loaded = new Map<string, Promise<FhirPackage>>(); // in progress

  constructor(options: FhirPackageCacheOptions = {}) {
    this.dir = options.dir ?? path.join(os.homedir(), '.fhir', 'packages');
    this.download = !!options.download;
    this.registry = (options.registry ?? 'https://packages.fhir.org').replace(
      /\/$/,
      '',
    );
    this._skip = options.skip ?? (name => NOT_NEEDED.test(name));
  }

  /** The folder of a package in the cache */
  packageDir(name: string, version: string): string {
    return path.join(this.dir, `${name}#${version}`, 'package');
  }

  /** Whether the cache has a package */
  has(name: string, version: string): boolean {
    return fs.existsSync(
      path.join(this.packageDir(name, version), 'package.json'),
    );
  }

  /** A package from the cache, downloaded first when missing and allowed */
  get(name: string, version: string): Promise<FhirPackage> {
    const id = `${name}#${version}`;
    let p = this._loaded.get(id);
    if (!p) {
      // only reads in progress are shared: a read package is not kept here
      p = this._get(name, version);
      this._loaded.set(id, p);
      p.then(
        () => this._loaded.delete(id),
        () => this._loaded.delete(id),
      );
    }
    return p;
  }

  private async _get(name: string, version: string): Promise<FhirPackage> {
    if (!EXACT_VERSION.test(version))
      throw new Error(`${name}#${version}: only exact versions are supported`);
    if (!this.has(name, version)) {
      if (!this.download)
        throw new Error(
          `${name}#${version} is not in the cache (${this.dir}); allow download, or add it there`,
        );
      await this._download(name, version);
    }
    return FhirPackage.fromDirectory(this.packageDir(name, version));
  }

  /**
   * A package and everything it depends on, dependencies first: the order
   * to load them in, so that value sets and code systems resolve across
   * packages
   */
  async resolve(name: string, version: string): Promise<FhirPackageResolution> {
    const order: FhirPackage[] = [];
    const versions = new Map<string, string>();
    const skipped = new Set<string>();
    const conflicts: string[] = [];
    const visit = async (
      n: string,
      v: string,
      from?: string,
    ): Promise<void> => {
      if (this._skip(n)) {
        skipped.add(`${n}#${v}`);
        return;
      }
      const seen = versions.get(n);
      if (seen !== undefined) {
        if (seen !== v)
          conflicts.push(`${n}: ${seen} is used, ${from ?? '?'} asks for ${v}`);
        return;
      }
      versions.set(n, v);
      const pkg = await this.get(n, v);
      for (const [dn, dv] of Object.entries(pkg.dependencies))
        await visit(dn, dv, pkg.id);
      order.push(pkg);
    };
    await visit(name, version);
    return { packages: order, skipped: [...skipped], conflicts };
  }

  /** Downloads a package's .tgz and writes its package/ folder to the cache */
  private async _download(name: string, version: string): Promise<void> {
    const url = `${this.registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
    const res = await fetch(url);
    if (!res.ok)
      throw new Error(`${name}#${version}: ${url} answered ${res.status}`);
    const files = readTgz(new Uint8Array(await res.arrayBuffer()));
    if (!files.has('package/package.json'))
      throw new Error(`${name}#${version}: the download is not a FHIR package`);
    // Written to a temporary folder, then moved: a broken download leaves nothing
    const target = path.join(this.dir, `${name}#${version}`);
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      for (const [file, content] of files) {
        const out = path.resolve(temp, file);
        // nothing outside the package's folder (../ in a name)
        if (!out.startsWith(path.resolve(temp) + path.sep)) continue;
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, content);
      }
      fs.mkdirSync(this.dir, { recursive: true });
      if (fs.existsSync(target))
        fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(temp, target);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}
