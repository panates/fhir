import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { FhirPackage, FhirPackageCache, readTgz } from '../src/index.js';
import { makeTgz } from './_support/tar.js';

const manifest = (
  name: string,
  version: string,
  dependencies: Record<string, string> = {},
) => JSON.stringify({ name, version, fhirVersions: ['4.0.1'], dependencies });
const valueSet = (url: string) =>
  JSON.stringify({
    resourceType: 'ValueSet',
    url,
    compose: { include: [{ system: 'http://x', concept: [{ code: 'a' }] }] },
  });

/** A registry on localhost serving the given .tgz files by "name/version" */
async function registry(packages: Record<string, Buffer>) {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const key = decodeURIComponent((req.url || '').slice(1));
    requests.push(key);
    const body = packages[key];
    res.writeHead(body ? 200 : 404).end(body);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise(r => server.close(r)),
  };
}

describe('Packages: .tgz, cache, dependencies', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhir-packages-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads a .tgz: regular files, ustar names', () => {
    const files = readTgz(
      makeTgz({ 'package/package.json': '{}', 'package/a/b.json': 'x' }),
    );
    expect([...files.keys()]).toEqual([
      'package/package.json',
      'package/a/b.json',
    ]);
    expect(files.get('package/a/b.json')!.toString()).toBe('x');
  });

  it('reads a package from its .tgz: conformance resources only, not examples', () => {
    const pkg = FhirPackage.fromTgz(
      makeTgz({
        'package/package.json': manifest('a.b', '1.0.0', { 'c.d': '2.0.0' }),
        'package/ValueSet-x.json': valueSet('http://a/x'),
        'package/Patient-p.json': '{"resourceType":"Patient"}',
        'package/example/ValueSet-y.json': valueSet('http://a/y'),
      }),
    );
    expect(pkg.id).toBe('a.b#1.0.0');
    expect(pkg.dependencies).toEqual({ 'c.d': '2.0.0' });
    expect(pkg.resourcesOf('ValueSet').map(v => v.url)).toEqual(['http://a/x']);
    expect(pkg.resourcesOf('Patient')).toEqual([]);
  });

  it('reads a package through its .index.json: a resource is parsed when asked for', () => {
    const index = {
      'index-version': 2,
      files: [
        {
          filename: 'ValueSet-x.json',
          resourceType: 'ValueSet',
          id: 'x',
          url: 'http://a/x',
        },
        {
          filename: 'ValueSet-y.json',
          resourceType: 'ValueSet',
          id: 'y',
          url: 'http://a/y',
        },
        {
          filename: '../evil.json',
          resourceType: 'ValueSet',
          url: 'http://a/evil',
        },
      ],
    };
    const pkg = FhirPackage.fromTgz(
      makeTgz({
        'package/package.json': manifest('a.b', '1.0.0'),
        'package/.index.json': JSON.stringify(index),
        'package/ValueSet-x.json': valueSet('http://a/x'),
        'package/ValueSet-y.json': valueSet('http://a/y'),
      }),
    );
    expect(pkg.entriesOf('ValueSet').map(e => e.url)).toEqual([
      'http://a/x',
      'http://a/y',
    ]);
    expect(pkg.parsedCount).toBe(0);
    expect(pkg.findResource('ValueSet', 'http://a/y|1.0')?.url).toBe(
      'http://a/y',
    );
    expect(pkg.parsedCount).toBe(1);
    expect(pkg.findResource('ValueSet', 'http://a/evil')).toBeUndefined();
  });

  it('does not download unless allowed', async () => {
    const cache = new FhirPackageCache({ dir });
    await expect(cache.get('a.b', '1.0.0')).rejects.toThrow(
      /is not in the cache/,
    );
  });

  it('downloads a missing package, with its dependencies, into the cache', async () => {
    const reg = await registry({
      'top.ig/1.0.0': makeTgz({
        'package/package.json': manifest('top.ig', '1.0.0', {
          'dep.one': '2.0.0',
          'hl7.fhir.r4.examples': '4.0.1',
        }),
        'package/ValueSet-t.json': valueSet('http://top/t'),
      }),
      'dep.one/2.0.0': makeTgz({
        'package/package.json': manifest('dep.one', '2.0.0', {
          'dep.two': '3.0.0',
        }),
      }),
      'dep.two/3.0.0': makeTgz({
        'package/package.json': manifest('dep.two', '3.0.0'),
      }),
    });
    try {
      const cache = new FhirPackageCache({
        dir,
        download: true,
        registry: reg.url,
      });
      const r = await cache.resolve('top.ig', '1.0.0');
      expect(r.packages.map(p => p.id)).toEqual([
        'dep.two#3.0.0',
        'dep.one#2.0.0',
        'top.ig#1.0.0',
      ]);
      expect(r.skipped).toEqual(['hl7.fhir.r4.examples#4.0.1']);
      expect(
        fs.existsSync(path.join(dir, 'top.ig#1.0.0/package/ValueSet-t.json')),
      ).toBe(true);
      // second time from the cache, without the registry
      await new FhirPackageCache({ dir }).resolve('top.ig', '1.0.0');
      expect(reg.requests.sort()).toEqual([
        'dep.one/2.0.0',
        'dep.two/3.0.0',
        'top.ig/1.0.0',
      ]);
    } finally {
      await reg.close();
    }
  });

  it('writes nothing outside the package folder (../ in a name)', async () => {
    const reg = await registry({
      'evil.pkg/1.0.0': makeTgz({
        'package/package.json': manifest('evil.pkg', '1.0.0'),
        '../../escaped.json': '{}',
      }),
    });
    try {
      await new FhirPackageCache({
        dir,
        download: true,
        registry: reg.url,
      }).get('evil.pkg', '1.0.0');
      expect(fs.existsSync(path.join(dir, '..', 'escaped.json'))).toBe(false);
      expect(fs.readdirSync(dir)).toEqual(['evil.pkg#1.0.0']);
    } finally {
      await reg.close();
    }
  });

  it('refuses version ranges, and reports a package asked in two versions', async () => {
    const cache = new FhirPackageCache({ dir });
    await expect(cache.get('a.b', '1.0.x')).rejects.toThrow(
      /only exact versions/,
    );
    const write = (
      name: string,
      version: string,
      deps: Record<string, string> = {},
    ) => {
      const d = path.join(dir, `${name}#${version}`, 'package');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(
        path.join(d, 'package.json'),
        manifest(name, version, deps),
      );
    };
    write('top.ig', '1.0.0', { 'a.dep': '1.0.0', 'b.dep': '1.0.0' });
    write('a.dep', '1.0.0', { shared: '1.0.0' });
    write('b.dep', '1.0.0', { shared: '2.0.0' });
    write('shared', '1.0.0');
    const r = await cache.resolve('top.ig', '1.0.0');
    expect(r.packages.map(p => p.id)).toEqual([
      'shared#1.0.0',
      'a.dep#1.0.0',
      'b.dep#1.0.0',
      'top.ig#1.0.0',
    ]);
    expect(r.conflicts).toEqual([
      'shared: 1.0.0 is used, b.dep#1.0.0 asks for 2.0.0',
    ]);
  });
});
