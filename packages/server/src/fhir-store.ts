import type { SearchQuery } from './search-query.js';
import type { FhirRequestContext } from './security.js';

/** What a store can do for a resource type */
export type FhirStoreInteraction =
  'read' | 'vread' | 'create' | 'update' | 'delete' | 'history' | 'search';

/** What a store declares for a resource type */
export interface StoreCapabilities {
  interactions: readonly FhirStoreInteraction[];
  /**
   * 'all': every version is kept (vread, history); 'current': the current
   * version's versionId is known and If-Match is checked, older versions are
   * not kept; 'none': no versions, no ETag, If-Match is refused
   */
  versions: 'all' | 'current' | 'none';
  /** An update of an id that does not exist creates the resource with that id */
  updateCreate?: boolean;
  /** The search parameters it answers, by code; all of the type's when not given */
  searchParams?: readonly string[];
  /** The parameters it can sort by */
  sort?: readonly string[];
}

/** A resource as a store keeps it */
export interface StoredResource {
  type: string;
  id: string;
  /** Its JSON form, with id and meta; undefined for a deleted resource */
  resource?: Record<string, any>;
  /** Absent in a store without versions */
  versionId?: string;
  /** An instant: '2026-11-22T10:15:00.000Z' */
  lastUpdated?: string;
}

/** A version written: how it came to be */
export interface StoredVersion extends StoredResource {
  method: 'POST' | 'PUT' | 'DELETE';
}

export interface HistoryQuery {
  /** _since: versions written at or after this instant */
  since?: string;
  /** _count: at most this many */
  count: number;
  /** The versions to skip, for the next page */
  offset: number;
}

/** A page of results, and how many there are in all when the store knows */
export interface StorePage<T> {
  items: T[];
  total?: number;
}

/**
 * Where a server keeps the resources of a type, or reads them from: the
 * in-memory store, a FHIR database, or a facade over a database of another
 * shape. Resources come and go in their JSON form; the server checks them
 * against the model before a write and after a read. A method the store does
 * not have, or an interaction it does not declare, answers 405.
 *
 * A store throws FhirServerError to refuse a request: 412 when `ifMatch` is
 * not the current version, 400 for what it cannot keep.
 *
 * Every method takes, last, the context of the request: the caller (when the
 * server has security), for a store that applies rules of its own per row.
 */
export interface FhirStore {
  /** What the store does for a type, asked once when the server starts; undefined: not this type */
  capabilities(type: string): StoreCapabilities | undefined;
  /** The current version; one with no `resource` when deleted; undefined when there never was one */
  read?(
    type: string,
    id: string,
    context?: FhirRequestContext,
  ): Promise<StoredResource | undefined>;
  vread?(
    type: string,
    id: string,
    versionId: string,
    context?: FhirRequestContext,
  ): Promise<StoredResource | undefined>;
  /** Stores a new resource; the store gives it its id, versionId and lastUpdated */
  create?(
    type: string,
    resource: Record<string, any>,
    context?: FhirRequestContext,
  ): Promise<StoredVersion>;
  /**
   * Replaces a resource; `ifMatch` is the version the client read. When the
   * id does not exist, it creates it (method POST) if the store declares
   * updateCreate, and answers undefined otherwise.
   */
  update?(
    type: string,
    id: string,
    resource: Record<string, any>,
    ifMatch?: string,
    context?: FhirRequestContext,
  ): Promise<StoredVersion | undefined>;
  /** Deletes a resource; undefined when there is none */
  delete?(
    type: string,
    id: string,
    ifMatch?: string,
    context?: FhirRequestContext,
  ): Promise<StoredVersion | undefined>;
  /** Versions, newest first: of an instance, a type, or all (type undefined) */
  history?(
    type: string | undefined,
    id: string | undefined,
    query: HistoryQuery,
    context?: FhirRequestContext,
  ): Promise<StorePage<StoredVersion>>;
  /**
   * The current resources of a type that match a search, a page of them
   * (query.offset, query.count), and how many match in all. The criteria
   * are parsed and typed; query.matches() checks one resource by FHIRPath,
   * for a store that has no query language of its own.
   */
  search?(
    type: string,
    query: SearchQuery,
    context?: FhirRequestContext,
  ): Promise<StorePage<StoredResource>>;
}
