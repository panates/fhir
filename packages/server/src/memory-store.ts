import { randomUUID } from 'node:crypto';
import { parseFhirJson } from '@fhirjs/core';
import { FhirServerError } from './fhir-server-error.js';
import type {
  FhirStore,
  HistoryQuery,
  StoreCapabilities,
  StoredResource,
  StoredVersion,
  StorePage,
} from './fhir-store.js';
import type { SearchLookup, SearchQuery } from './search-query.js';

/** A version as the memory store keeps it: the resource as JSON text */
interface Version {
  type: string;
  id: string;
  versionId: string;
  lastUpdated: string;
  method: 'POST' | 'PUT' | 'DELETE';
  text?: string;
}

const CAPABILITIES: StoreCapabilities = {
  interactions: [
    'read',
    'vread',
    'create',
    'update',
    'delete',
    'history',
    'search',
  ],
  versions: 'all',
  updateCreate: true,
  acceptsIds: true,
  chains: true,
};

/**
 * A store in memory, for tests and small servers: every resource type, every
 * version kept. Resources are kept as JSON text, so a decimal keeps the
 * places it was written with.
 *
 * A transaction holds the store: other requests wait until it ends, and its
 * writes are undone when it fails.
 */
export class MemoryStore implements FhirStore {
  /** Every version written, oldest first */
  private readonly _log: Version[] = [];
  /** The versions of each resource, oldest first, by 'type/id' */
  private readonly _byKey = new Map<string, Version[]>();
  private _lastTime = 0;
  /** Settles when the transaction running, or the last one waiting, ends */
  private _turn: Promise<void> = Promise.resolve();
  /** The store as a transaction sees it: the same methods, without waiting */
  private readonly _view: FhirStore = {
    capabilities: () => CAPABILITIES,
    read: async (type, id) => this._read(type, id),
    vread: async (type, id, versionId) => this._vread(type, id, versionId),
    create: async (type, resource) => this._create(type, resource),
    update: async (type, id, resource, ifMatch) =>
      this._update(type, id, resource, ifMatch),
    delete: async (type, id, ifMatch) => this._delete(type, id, ifMatch),
    history: async (type, id, query) => this._history(type, id, query),
    search: async (type, query) => this._search(type, query),
  };

  capabilities(): StoreCapabilities {
    return CAPABILITIES;
  }

  async read(type: string, id: string): Promise<StoredResource | undefined> {
    await this._turn;
    return this._read(type, id);
  }

  async vread(
    type: string,
    id: string,
    versionId: string,
  ): Promise<StoredResource | undefined> {
    await this._turn;
    return this._vread(type, id, versionId);
  }

  async create(
    type: string,
    resource: Record<string, any>,
  ): Promise<StoredVersion> {
    await this._turn;
    return this._create(type, resource);
  }

  async update(
    type: string,
    id: string,
    resource: Record<string, any>,
    ifMatch?: string,
  ): Promise<StoredVersion | undefined> {
    await this._turn;
    return this._update(type, id, resource, ifMatch);
  }

  async delete(
    type: string,
    id: string,
    ifMatch?: string,
  ): Promise<StoredVersion | undefined> {
    await this._turn;
    return this._delete(type, id, ifMatch);
  }

  async history(
    type: string | undefined,
    id: string | undefined,
    query: HistoryQuery,
  ): Promise<StorePage<StoredVersion>> {
    await this._turn;
    return this._history(type, id, query);
  }

  async search(
    type: string,
    query: SearchQuery,
  ): Promise<StorePage<StoredResource>> {
    await this._turn;
    return this._search(type, query);
  }

  async transaction<T>(work: (tx: FhirStore) => Promise<T>): Promise<T> {
    const before = this._turn;
    let end!: () => void;
    this._turn = new Promise<void>(resolve => (end = resolve));
    await before;
    const mark = this._log.length;
    try {
      return await work(this._view);
    } catch (e) {
      this._undo(mark);
      throw e;
    } finally {
      end();
    }
  }

  /* The methods themselves: synchronous, so that nothing comes between */

  private _read(type: string, id: string): StoredResource | undefined {
    const v = this._versions(type, id)?.at(-1);
    return v && stored(v);
  }

  private _vread(
    type: string,
    id: string,
    versionId: string,
  ): StoredResource | undefined {
    const v = this._versions(type, id)?.find(x => x.versionId === versionId);
    return v && stored(v);
  }

  private _create(type: string, resource: Record<string, any>): StoredVersion {
    const id = resource.id ?? randomUUID();
    if (this._versions(type, id)?.at(-1)?.text !== undefined)
      throw new FhirServerError(
        409,
        `${type}/${id} exists already`,
        'duplicate',
      );
    return this._write(type, id, resource, 'POST');
  }

  private _update(
    type: string,
    id: string,
    resource: Record<string, any>,
    ifMatch?: string,
  ): StoredVersion {
    const current = this._versions(type, id)?.at(-1);
    checkMatch(type, id, current, ifMatch);
    // an id never used, or a deleted one: created anew
    return this._write(
      type,
      id,
      resource,
      current?.text === undefined ? 'POST' : 'PUT',
    );
  }

  private _delete(
    type: string,
    id: string,
    ifMatch?: string,
  ): StoredVersion | undefined {
    const current = this._versions(type, id)?.at(-1);
    if (!current || current.text === undefined) return;
    checkMatch(type, id, current, ifMatch);
    return this._write(type, id, undefined, 'DELETE');
  }

  private _history(
    type: string | undefined,
    id: string | undefined,
    query: HistoryQuery,
  ): StorePage<StoredVersion> {
    let list =
      type && id
        ? (this._versions(type, id) ?? [])
        : type
          ? this._log.filter(v => v.type === type)
          : this._log;
    if (query.since) {
      const since = Date.parse(query.since);
      list = list.filter(v => Date.parse(v.lastUpdated) >= since);
    }
    const newest = [...list].reverse();
    return {
      items: newest
        .slice(query.offset, query.offset + query.count)
        .map(v => ({ ...stored(v), method: v.method })),
      total: newest.length,
    };
  }

  private _search(type: string, query: SearchQuery): StorePage<StoredResource> {
    const matches: StoredResource[] = [];
    for (const versions of this._byKey.values()) {
      const v = versions.at(-1)!;
      if (v.type !== type || v.text === undefined) continue;
      const s = stored(v);
      if (query.matches(s.resource!, this._lookup)) matches.push(s);
    }
    if (query.sort.length)
      matches.sort((a, b) => query.compare(a.resource!, b.resource!));
    return {
      items: matches.slice(query.offset, query.offset + query.count),
      total: matches.length,
    };
  }

  /** The current resources, for chained criteria */
  private readonly _lookup: SearchLookup = {
    read: (type, id) => this._read(type, id)?.resource,
    all: function* (this: MemoryStore, type: string) {
      for (const versions of this._byKey.values()) {
        const v = versions.at(-1)!;
        if (v.type === type && v.text !== undefined) yield stored(v).resource!;
      }
    }.bind(this) as SearchLookup['all'],
  };

  private _versions(type: string, id: string): Version[] | undefined {
    return this._byKey.get(`${type}/${id}`);
  }

  /** Takes back the versions written since the log had `mark` of them */
  private _undo(mark: number) {
    for (const v of this._log.splice(mark).reverse()) {
      const key = `${v.type}/${v.id}`;
      const versions = this._byKey.get(key)!;
      versions.pop();
      if (!versions.length) this._byKey.delete(key);
    }
  }

  private _write(
    type: string,
    id: string,
    resource: Record<string, any> | undefined,
    method: Version['method'],
  ): StoredVersion {
    const key = `${type}/${id}`;
    let versions = this._byKey.get(key);
    if (!versions) this._byKey.set(key, (versions = []));
    const versionId = String(versions.length + 1);
    // one millisecond apart at least, so that versions keep their order by time
    const time = Math.max(Date.now(), this._lastTime + 1);
    this._lastTime = time;
    const lastUpdated = new Date(time).toISOString();
    const v: Version = { type, id, versionId, lastUpdated, method };
    if (resource) {
      const { resourceType: _r, id: _i, meta, ...rest } = resource;
      v.text = JSON.stringify({
        resourceType: type,
        id,
        meta: { ...meta, versionId, lastUpdated },
        ...rest,
      });
    }
    versions.push(v);
    this._log.push(v);
    return { ...stored(v), method };
  }
}

function stored(v: Version): StoredResource {
  const s: StoredResource = {
    type: v.type,
    id: v.id,
    versionId: v.versionId,
    lastUpdated: v.lastUpdated,
  };
  if (v.text !== undefined) s.resource = parseFhirJson(v.text);
  return s;
}

/** Refuses a write whose If-Match is not the current version */
function checkMatch(
  type: string,
  id: string,
  current: Version | undefined,
  ifMatch: string | undefined,
) {
  if (ifMatch === undefined || current?.versionId === ifMatch) return;
  throw new FhirServerError(
    412,
    current
      ? `${type}/${id}: version ${ifMatch} is not the current one (${current.versionId})`
      : `${type}/${id} does not exist`,
    'conflict',
  );
}
