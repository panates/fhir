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
  interactions: ['read', 'vread', 'create', 'update', 'delete', 'history'],
  versions: 'all',
  updateCreate: true,
};

/**
 * A store in memory, for tests and small servers: every resource type, every
 * version kept. Resources are kept as JSON text, so a decimal keeps the
 * places it was written with.
 */
export class MemoryStore implements FhirStore {
  /** Every version written, oldest first */
  private readonly _log: Version[] = [];
  /** The versions of each resource, oldest first, by 'type/id' */
  private readonly _byKey = new Map<string, Version[]>();
  private _lastTime = 0;

  capabilities(): StoreCapabilities {
    return CAPABILITIES;
  }

  async read(type: string, id: string): Promise<StoredResource | undefined> {
    const v = this._versions(type, id)?.at(-1);
    return v && stored(v);
  }

  async vread(
    type: string,
    id: string,
    versionId: string,
  ): Promise<StoredResource | undefined> {
    const v = this._versions(type, id)?.find(x => x.versionId === versionId);
    return v && stored(v);
  }

  async create(
    type: string,
    resource: Record<string, any>,
  ): Promise<StoredVersion> {
    return this._write(type, randomUUID(), resource, 'POST');
  }

  async update(
    type: string,
    id: string,
    resource: Record<string, any>,
    ifMatch?: string,
  ): Promise<StoredVersion | undefined> {
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

  async delete(
    type: string,
    id: string,
    ifMatch?: string,
  ): Promise<StoredVersion | undefined> {
    const current = this._versions(type, id)?.at(-1);
    if (!current || current.text === undefined) return;
    checkMatch(type, id, current, ifMatch);
    return this._write(type, id, undefined, 'DELETE');
  }

  async history(
    type: string | undefined,
    id: string | undefined,
    query: HistoryQuery,
  ): Promise<StorePage<StoredVersion>> {
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

  private _versions(type: string, id: string): Version[] | undefined {
    return this._byKey.get(`${type}/${id}`);
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
