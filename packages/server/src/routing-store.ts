import { FhirServerError } from './fhir-server-error.js';
import type {
  FhirStore,
  HistoryQuery,
  StoreCapabilities,
  StoredResource,
  StoredVersion,
  StorePage,
} from './fhir-store.js';
import type { SearchQuery } from './search-query.js';
import type { FhirRequestContext } from './security.js';

export interface RoutingStoreOptions {
  /** The store of the types that have none of their own in `routes`; it runs transactions */
  store?: FhirStore;
  /** Stores of their own, by resource type: a facade over an existing database */
  routes: Record<string, FhirStore>;
}

/**
 * A store that sends each resource type to a store of its own: a facade
 * over an existing database for some types, and a FHIR database for the
 * rest. What crosses stores it does not do, and declares so:
 *
 * - chains and `_has` go only to the types of the same store;
 * - a transaction runs in the default store; types in other stores can be
 *   read in it, and are not written (400);
 * - the history of the whole server merges the stores' histories.
 *
 * ```ts
 * new FhirServer({
 *   fhir,
 *   store: new RoutingStore({ store: new MemoryStore(), routes: { Patient: hbys } }),
 * });
 * ```
 */
export class RoutingStore implements FhirStore {
  readonly transaction?: FhirStore['transaction'];
  private readonly _default?: FhirStore;
  private readonly _routes: Record<string, FhirStore>;

  constructor(options: RoutingStoreOptions) {
    this._default = options.store;
    this._routes = { ...options.routes };
    const main = options.store;
    if (main?.transaction)
      this.transaction = (work, context) =>
        main.transaction!(
          view =>
            work(
              new RoutingStore({
                store: view,
                routes: Object.fromEntries(
                  Object.entries(this._routes).map(([type, store]) => [
                    type,
                    store === main ? view : readOnly(store),
                  ]),
                ),
              }),
            ),
          context,
        );
  }

  /** The store of a type; undefined when none */
  storeOf(type: string): FhirStore | undefined {
    return Object.hasOwn(this._routes, type)
      ? this._routes[type]
      : this._default;
  }

  capabilities(type: string): StoreCapabilities | undefined {
    const store = this.storeOf(type);
    const caps = store?.capabilities(type);
    if (!caps?.chains) return caps;
    // chains only to the types of the same store, as far as it chains
    const own = caps.chains;
    return {
      ...caps,
      chains: target =>
        this.storeOf(target) === store && (own === true || own(target)),
    };
  }

  async read(
    type: string,
    id: string,
    context?: FhirRequestContext,
  ): Promise<StoredResource | undefined> {
    return this._method(type, 'read').call(
      this.storeOf(type),
      type,
      id,
      context,
    );
  }

  async vread(
    type: string,
    id: string,
    versionId: string,
    context?: FhirRequestContext,
  ): Promise<StoredResource | undefined> {
    return this._method(type, 'vread').call(
      this.storeOf(type),
      type,
      id,
      versionId,
      context,
    );
  }

  async create(
    type: string,
    resource: Record<string, any>,
    context?: FhirRequestContext,
  ): Promise<StoredVersion> {
    return this._method(type, 'create').call(
      this.storeOf(type),
      type,
      resource,
      context,
    );
  }

  async update(
    type: string,
    id: string,
    resource: Record<string, any>,
    ifMatch?: string,
    context?: FhirRequestContext,
  ): Promise<StoredVersion | undefined> {
    return this._method(type, 'update').call(
      this.storeOf(type),
      type,
      id,
      resource,
      ifMatch,
      context,
    );
  }

  async delete(
    type: string,
    id: string,
    ifMatch?: string,
    context?: FhirRequestContext,
  ): Promise<StoredVersion | undefined> {
    return this._method(type, 'delete').call(
      this.storeOf(type),
      type,
      id,
      ifMatch,
      context,
    );
  }

  async search(
    type: string,
    query: SearchQuery,
    context?: FhirRequestContext,
  ): Promise<StorePage<StoredResource>> {
    return this._method(type, 'search').call(
      this.storeOf(type),
      type,
      query,
      context,
    );
  }

  async history(
    type: string | undefined,
    id: string | undefined,
    query: HistoryQuery,
    context?: FhirRequestContext,
  ): Promise<StorePage<StoredVersion>> {
    if (type !== undefined)
      return this._method(type, 'history').call(
        this.storeOf(type),
        type,
        id,
        query,
        context,
      );
    // the whole server: the stores' histories merged, newest first
    const stores = new Set(
      [this._default, ...Object.values(this._routes)].filter(
        (s): s is FhirStore => !!s,
      ),
    );
    if (stores.size === 1) {
      const [only] = stores;
      if (!only.history) throw notSupported('history of the whole server');
      return only.history(undefined, undefined, query, context);
    }
    const pages = await Promise.all(
      [...stores].map(store => {
        if (!store.history) throw notSupported('history of the whole server');
        return store.history(
          undefined,
          undefined,
          { since: query.since, count: query.offset + query.count, offset: 0 },
          context,
        );
      }),
    );
    const items = pages
      .flatMap(p => p.items)
      .sort((a, b) => (b.lastUpdated ?? '').localeCompare(a.lastUpdated ?? ''))
      .slice(query.offset, query.offset + query.count);
    const known = pages.every(p => p.total !== undefined);
    return {
      items,
      total: known ? pages.reduce((n, p) => n + p.total!, 0) : undefined,
    };
  }

  /** The method of a type's store; 405 when it has none */
  private _method<K extends StoreMethod>(
    type: string,
    name: K,
  ): NonNullable<FhirStore[K]> {
    const method = this.storeOf(type)?.[name];
    if (typeof method !== 'function') throw notSupported(`${name} of ${type}`);
    return method as NonNullable<FhirStore[K]>;
  }
}

type StoreMethod =
  'read' | 'vread' | 'create' | 'update' | 'delete' | 'history' | 'search';

/** A store in a transaction that is not its own: read, not written */
function readOnly(store: FhirStore): FhirStore {
  const refuse = async (type: string): Promise<never> => {
    throw new FhirServerError(
      400,
      `${type} is in a store of its own, which takes no part in the transaction`,
      'not-supported',
    );
  };
  return {
    capabilities: type => store.capabilities(type),
    read: store.read?.bind(store),
    vread: store.vread?.bind(store),
    history: store.history?.bind(store),
    search: store.search?.bind(store),
    create: type => refuse(type),
    update: type => refuse(type),
    delete: type => refuse(type),
  };
}

function notSupported(what: string): FhirServerError {
  return new FhirServerError(405, `${what} is not supported`, 'not-supported');
}
