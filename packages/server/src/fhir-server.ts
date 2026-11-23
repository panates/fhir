import { randomUUID } from 'node:crypto';
import {
  type FhirContext,
  type FhirSearchParameter,
  getDecimalText,
  parseFhirJson,
  rawDecimal,
} from '@fhirjs/core';
import {
  BulkExport,
  type BulkExportOptions,
  type ExportHost,
} from './bulk-export.js';
import { type FhirOutcomeIssue, FhirServerError } from './fhir-server-error.js';
import type {
  FhirStore,
  FhirStoreInteraction,
  StoreCapabilities,
  StoredResource,
  StoredVersion,
} from './fhir-store.js';
import { applyJsonPatch } from './json-patch.js';
import type {
  FhirAccessDecision,
  FhirInteraction,
  FhirPrincipal,
  FhirRequestContext,
  FhirSecurityOptions,
} from './security.js';
import { SearchMatcher } from './search-match.js';
import {
  parseCriterion,
  RESULT_PARAMS,
  SEARCH_TYPES,
  type SearchComponent,
  type SearchCriterion,
  type SearchQuery,
  type SearchValue,
  type SearchSort,
} from './search-query.js';
import { subsetOf, subsetted } from './subset.js';

/** A step around each exchange: (request, next) => response, as in the client */
export type FhirServerInterceptor = (
  request: Request,
  next: (request: Request) => Promise<Response>,
) => Promise<Response>;

export interface FhirServerOptions {
  /** The FHIR version's model (and profiles, packages) resources are checked with */
  fhir: FhirContext;
  /**
   * Where the resources are kept. One store serves every type; a
   * RoutingStore sends types to stores of their own.
   */
  store: FhirStore;
  /** The resource types served; every type a store declares when not given */
  resources?: readonly string[];
  /** The path the server answers under: '/fhir'. The root when not given */
  base?: string;
  /** Steps around each exchange, the first given outermost */
  interceptors?: readonly FhirServerInterceptor[];
  /** Entries of a history page when _count is not given (default 50) */
  defaultCount?: number;
  /** The most entries a page has, whatever _count asks (default 500) */
  maxCount?: number;
  /** The most entries a batch or transaction Bundle may have (default 100) */
  maxBundleEntries?: number;
  /** The most resources _include and _revinclude add to a page (default 1000) */
  maxIncludes?: number;
  /** The software name in the CapabilityStatement */
  name?: string;
  /**
   * Who may call, and what they may do: authenticators and an authorizer.
   * The server is open without it.
   */
  security?: FhirSecurityOptions;
  /** Called with an error the server did not expect; the client gets a 500 */
  onError?: (error: unknown, request: Request) => void;
  /**
   * Bulk Data export ($export of the server, the patients and a group),
   * with where its files go. Not served when not given.
   */
  bulkExport?: BulkExportOptions;
}

/** A type the server serves, with its store and what the store declared */
interface Served {
  store: FhirStore;
  caps: StoreCapabilities;
  /** The search parameters the store answers and the server parses, by code */
  params: Map<string, FhirSearchParameter>;
  /** The parts of its composite parameters, by code */
  components: Map<string, SearchComponent[]>;
}

const FHIR_JSON = 'application/fhir+json';
/** The Bulk Data Access IG */
const BULK_DATA = 'http://hl7.org/fhir/uv/bulkdata';
const JSON_TYPES = new Set([
  FHIR_JSON,
  'application/json',
  'application/json+fhir',
]);
const JSON_FORMATS = new Set(['json', ...JSON_TYPES]);
/** A FHIR id, and a version id */
const ID = /^[A-Za-z0-9\-.]{1,64}$/;
/** The links a chain may have: subject:Patient.organization.name is two */
const MAX_CHAIN = 3;
/** The rounds of :iterate after the first include */
const MAX_ITERATE = 3;

/** The store method each interaction needs */
const METHOD: Record<FhirStoreInteraction, keyof FhirStore | undefined> = {
  read: 'read',
  vread: 'vread',
  create: 'create',
  update: 'update',
  delete: 'delete',
  history: 'history',
  search: 'search',
};

/** CapabilityStatement interaction codes of a store's interactions */
const CAPABILITY_CODES: Record<FhirStoreInteraction, string[]> = {
  read: ['read'],
  vread: ['vread'],
  create: ['create'],
  update: ['update'],
  delete: ['delete'],
  history: ['history-instance', 'history-type'],
  search: ['search-type'],
};

const STATUS_LINE: Record<StoredVersion['method'], string> = {
  POST: '201 Created',
  PUT: '200 OK',
  DELETE: '204 No Content',
};

/**
 * A FHIR server: answers the REST API of a FHIR version from a store, as a
 * fetch-style handler. It runs in any server that speaks Request and
 * Response, and in node:http through nodeListener().
 *
 * ```ts
 * const server = new FhirServer({ fhir: new FhirContext(r4Model), store: new MemoryStore(), base: '/fhir' });
 * http.createServer(nodeListener(server)).listen(8080);
 * ```
 */
export class FhirServer {
  readonly fhir: FhirContext;
  readonly base: string;
  private readonly _main: FhirStore;
  private readonly _served = new Map<string, Served>();
  private readonly _handle: (request: Request) => Promise<Response>;
  private readonly _date = new Date().toISOString();
  private readonly _matcher: SearchMatcher;
  /** $export, when the options give it */
  readonly bulkExport?: BulkExport;

  constructor(readonly options: FhirServerOptions) {
    this.fhir = options.fhir;
    this._matcher = new SearchMatcher(this.fhir);
    this.base = (options.base ?? '').replace(/\/+$/, '');
    if (this.base && !this.base.startsWith('/'))
      throw new TypeError(`base must be a path: "${options.base}"`);
    this._main = options.store;
    const model = this.fhir.model;
    const types = options.resources ?? model.resourceTypes();
    for (const type of types) {
      if (!model.resourceTypes().includes(type))
        throw new TypeError(
          `${type} is not a resource type of FHIR ${model.fhirVersion}`,
        );
      const store = options.store;
      const caps = store.capabilities(type);
      if (caps)
        this._served.set(type, {
          store,
          caps,
          ...searchParams(model, type, caps),
        });
      else if (options.resources)
        throw new TypeError(`The store does not serve ${type}`);
    }
    if (options.bulkExport)
      this.bulkExport = new BulkExport(options.bulkExport, this._exportHost());
    this._handle = (options.interceptors ?? []).reduceRight<
      (r: Request) => Promise<Response>
    >(
      (next, interceptor) => r => interceptor(r, next),
      r => this._answer(r),
    );
  }

  /** The resource types served */
  get resourceTypes(): string[] {
    return [...this._served.keys()];
  }

  /** Answers a request; never throws for a bad one: the answer is an OperationOutcome */
  handle(request: Request): Promise<Response> {
    return this._handle(request);
  }

  private async _answer(request: Request): Promise<Response> {
    try {
      return await this._route(request);
    } catch (e) {
      if (e instanceof FhirServerError) return outcomeResponse(e);
      this.options.onError?.(e, request);
      return outcomeResponse(
        new FhirServerError(
          500,
          'The server could not answer the request',
          'exception',
        ),
      );
    }
  }

  private async _route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname;
    if (this.base) {
      if (path !== this.base && !path.startsWith(this.base + '/'))
        throw new FhirServerError(
          404,
          `${path} is not under ${this.base}`,
          'not-found',
        );
      path = path.slice(this.base.length);
    }
    const seg = path
      .split('/')
      .filter(Boolean)
      .map(s => decodeURIComponent(s));
    // an export's files are NDJSON
    if (!(this.bulkExport && seg[0] === '$export-file'))
      checkFormat(request, url);
    const method = request.method.toUpperCase();
    const ctx: Exchange = {
      request,
      url,
      method,
      baseUrl: url.origin + this.base,
      context: { request },
    };

    if (seg[0] === 'metadata' && seg.length === 1) {
      if (method !== 'GET') throw notAllowed(method, 'metadata');
      return jsonResponse(
        200,
        JSON.stringify(this.capabilityStatement(ctx.baseUrl)),
      );
    }
    if (
      seg.length === 2 &&
      seg[0] === '.well-known' &&
      seg[1] === 'smart-configuration' &&
      this.options.security?.smartConfiguration
    ) {
      if (method !== 'GET')
        throw notAllowed(method, '.well-known/smart-configuration');
      return new Response(
        JSON.stringify(this.options.security.smartConfiguration),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        },
      );
    }
    // everything else needs a caller, when the server has security
    ctx.context.principal = await this._authenticate(ctx);
    if (this.bulkExport) {
      const answer = await this._export(ctx, seg);
      if (answer) return answer;
    }
    if (!seg.length) {
      if (method !== 'POST') throw notAllowed(method, 'the server base');
      return this._bundle(ctx);
    }
    return this._dispatch(ctx, seg, path);
  }

  /**
   * An interaction on a path under the base, for a caller already
   * authenticated: a request, or an entry of a batch
   */
  private async _dispatch(
    ctx: Exchange,
    seg: string[],
    path: string,
  ): Promise<Response> {
    const method = ctx.method;
    if (seg[0] === '_history' && seg.length === 1) {
      if (method !== 'GET') throw notAllowed(method, '_history');
      return this._history(
        ctx,
        this._inTx(ctx, this._systemStore()),
        undefined,
        undefined,
      );
    }
    if (
      seg.length === 2 &&
      seg[1] === '$validate' &&
      this._served.has(seg[0])
    ) {
      if (method !== 'POST') throw notAllowed(method, `${seg[0]}/$validate`);
      return this._validate(ctx, seg[0]);
    }
    if (seg[0].startsWith('$') || seg.some(s => s.startsWith('$')))
      throw new FhirServerError(
        404,
        `Unknown operation ${seg.find(s => s.startsWith('$'))}`,
        'not-supported',
      );

    const type = seg[0];
    const served = this._servedOf(ctx, type);
    if (!served)
      throw new FhirServerError(
        404,
        `Resource type ${type} is not served`,
        'not-supported',
      );
    const [, id, op, vid] = seg;
    if (
      id !== undefined &&
      id !== '_history' &&
      id !== '_search' &&
      !ID.test(id)
    )
      throw new FhirServerError(400, `"${id}" is not a valid id`, 'value');
    if (vid !== undefined && !ID.test(vid))
      throw new FhirServerError(
        400,
        `"${vid}" is not a valid version id`,
        'value',
      );

    switch (seg.length) {
      case 1:
        if (method === 'POST') return this._create(ctx, type, served);
        if (method === 'GET') return this._search(ctx, type, served);
        // conditional interactions: [type]?criteria
        if (ctx.url.search.length > 1) {
          if (method === 'PUT')
            return this._conditionalUpdate(ctx, type, served);
          if (method === 'DELETE')
            return this._conditionalDelete(ctx, type, served);
          if (method === 'PATCH')
            return this._patch(ctx, type, undefined, served);
        }
        throw notAllowed(method, type);
      case 2:
        if (id === '_search') {
          if (method !== 'POST') throw notAllowed(method, `${type}/_search`);
          return this._search(ctx, type, served);
        }
        if (id === '_history') {
          if (method !== 'GET') throw notAllowed(method, `${type}/_history`);
          return this._history(ctx, served, type, undefined);
        }
        if (method === 'GET') return this._read(ctx, type, id, served);
        if (method === 'PUT') return this._update(ctx, type, id, served);
        if (method === 'DELETE') return this._delete(ctx, type, id, served);
        if (method === 'PATCH') return this._patch(ctx, type, id, served);
        throw notAllowed(method, `${type}/${id}`);
      case 3:
        if (op !== '_history') break;
        if (method !== 'GET')
          throw notAllowed(method, `${type}/${id}/_history`);
        return this._history(ctx, served, type, id);
      case 4:
        if (op !== '_history') break;
        if (method !== 'GET')
          throw notAllowed(method, `${type}/${id}/_history/${vid}`);
        return this._vread(ctx, type, id, vid, served);
    }
    throw new FhirServerError(
      404,
      `${path} is not a FHIR interaction`,
      'not-found',
    );
  }

  /* ---------------------------------------------------------------- */
  /* Batch and transaction                                            */
  /* ---------------------------------------------------------------- */

  /**
   * POST [base] with a batch or transaction Bundle. A batch: each entry an
   * interaction of its own, authorized as such, in the order given; one that
   * fails does not stop the others. A transaction: all or nothing (see
   * _transaction). The answer is a batch-response or transaction-response
   * Bundle, an entry per entry in the order of the request.
   */
  private async _bundle(ctx: Exchange): Promise<Response> {
    const mediaType = mediaTypeOf(ctx.request.headers.get('Content-Type'));
    if (!mediaType || !JSON_TYPES.has(mediaType))
      throw new FhirServerError(
        415,
        `A Bundle is sent as ${FHIR_JSON}, not ${mediaType || 'no content type'}`,
        'not-supported',
      );
    let bundle: any;
    try {
      bundle = parseFhirJson(await ctx.request.text());
    } catch {
      throw new FhirServerError(400, 'The body is not JSON', 'structure');
    }
    if (bundle?.resourceType !== 'Bundle')
      throw new FhirServerError(400, 'POST [base] takes a Bundle', 'invalid');
    const kind = bundle.type;
    if (kind !== 'batch' && kind !== 'transaction')
      throw new FhirServerError(
        400,
        `POST [base] takes a batch or transaction Bundle, not a ${kind ?? 'Bundle without type'}`,
        'invalid',
      );
    const entries: any[] = Array.isArray(bundle.entry) ? bundle.entry : [];
    const max = this.options.maxBundleEntries ?? 100;
    if (entries.length > max)
      throw new FhirServerError(
        413,
        `The Bundle has ${entries.length} entries; this server takes ${max} at most`,
        'too-costly',
      );
    let out: Record<string, any>[];
    if (kind === 'transaction') out = await this._transaction(ctx, entries);
    else {
      out = [];
      for (const [i, entry] of entries.entries())
        out.push(await entryOf(await this._entry(ctx, entry, i)));
    }
    // the entries' resources keep the places of their decimals
    return jsonResponse(
      200,
      stringifyJson({
        resourceType: 'Bundle',
        type: `${kind}-response`,
        ...(out.length ? { entry: out } : {}),
      }),
    );
  }

  /**
   * The entries of a transaction, all or nothing, in the store's
   * transaction: deletes, then creates, then updates and patches, then reads
   * and searches. New resources with a placeholder fullUrl (urn:uuid:) get
   * their ids first, and the references to them are rewritten; conditional
   * references are resolved by a search. An entry that fails ends it: its
   * status and outcome are the answer, and nothing is written.
   */
  private async _transaction(
    ctx: Exchange,
    entries: any[],
  ): Promise<Record<string, any>[]> {
    if (!entries.length) return [];
    const types = entries.map((entry, i) => {
      entryMethod(entry, i);
      const type = entry.request.url
        .replace(/^\/+/, '')
        .split(/[/?]/)[0] as string;
      if (!type)
        throw new FhirServerError(
          400,
          `Entry ${i}: a transaction cannot hold a request on the server base`,
          'not-supported',
        );
      if (!this._served.has(type))
        throw new FhirServerError(
          404,
          `Entry ${i}: resource type ${type} is not served`,
          'not-supported',
        );
      return type;
    });
    const store = this._main;
    if (!store.transaction)
      throw new FhirServerError(
        400,
        'Transactions are not supported: the store has no transaction()',
        'not-supported',
      );
    const methodOf = (i: number) => entries[i].request.method.toUpperCase();
    const RANK: Record<string, number> = {
      DELETE: 0,
      POST: 1,
      PUT: 2,
      PATCH: 2,
    };
    const order = [...entries.keys()].sort(
      (a, b) => (RANK[methodOf(a)] ?? 3) - (RANK[methodOf(b)] ?? 3),
    );
    return store.transaction(async view => {
      const tx: Exchange = { ...ctx, tx: view };
      const out: Record<string, any>[] = [];
      const run = async (i: number, assignedId?: string) => {
        const response = await this._entry(tx, entries[i], i, assignedId);
        if (response.status >= 400) throw await entryFailure(response, i);
        out[i] = await entryOf(response);
      };
      const deletes = order.filter(i => methodOf(i) === 'DELETE');
      for (const i of deletes) await run(i);
      const assigned = await this._placeholders(tx, entries, types);
      const rest = order.filter(i => methodOf(i) !== 'DELETE');
      for (const i of rest) await run(i, assigned.get(i));
      return out;
    }, ctx.context);
  }

  /**
   * Gives the new resources of a transaction their ids and rewrites the
   * references: to a placeholder fullUrl (urn:uuid:), to the resource's
   * Type/id; a conditional one (Patient?identifier=...), to the one resource
   * its criteria find (412 for none or more). A conditional create that
   * finds its resource is referred to as that one. The ids given, by entry.
   */
  private async _placeholders(
    tx: Exchange,
    entries: any[],
    types: string[],
  ): Promise<Map<number, string>> {
    const assigned = new Map<number, string>();
    const targets = new Map<string, string>();
    for (const [i, entry] of entries.entries()) {
      const fullUrl = entry.fullUrl;
      if (typeof fullUrl !== 'string' || !/^urn:(uuid|oid):/.test(fullUrl))
        continue;
      const type = types[i];
      const method = entry.request.method.toUpperCase();
      const path = entry.request.url.replace(/^\/+/, '');
      if (method === 'PUT' && !path.includes('?')) {
        targets.set(fullUrl, path);
        continue;
      }
      if (method !== 'POST') continue;
      const served = this._servedOf(tx, type)!;
      const ifNoneExist = entry.request.ifNoneExist;
      if (typeof ifNoneExist === 'string') {
        const found = await this._matchesOf(
          tx,
          ifNoneExist.replace(/^\?/, ''),
          type,
          served,
          `Entry ${i}: conditional create`,
          'create',
        );
        if (found.length > 1)
          throw new FhirServerError(
            412,
            `Entry ${i}: If-None-Exist: ${ifNoneExist} finds more than one ${type}`,
            'multiple-matches',
          );
        if (found.length) {
          targets.set(fullUrl, `${type}/${found[0].id}`);
          continue;
        }
      }
      if (!served.caps.acceptsIds)
        throw new FhirServerError(
          400,
          `Entry ${i}: the store of ${type} gives ids itself, so a transaction cannot refer to a new ${type} by its fullUrl`,
          'not-supported',
        );
      const id = randomUUID();
      assigned.set(i, id);
      targets.set(fullUrl, `${type}/${id}`);
    }
    // the references of every resource, once each criteria
    const resolved = new Map<string, string>();
    const resolve = async (reference: string, i: number) => {
      const type = reference.slice(0, reference.indexOf('?'));
      const served = this._servedOf(tx, type);
      if (!served)
        throw new FhirServerError(
          400,
          `Entry ${i}: ${reference}: resource type ${type} is not served`,
          'not-supported',
        );
      await this._authorize(tx, 'search', type);
      const found = await this._matchesOf(
        tx,
        reference.slice(type.length + 1),
        type,
        served,
        `Entry ${i}: conditional reference`,
        'search',
      );
      if (found.length !== 1)
        throw new FhirServerError(
          412,
          `Entry ${i}: the conditional reference ${reference} finds ${found.length ? 'more than one' : 'no'} ${type}`,
          found.length ? 'multiple-matches' : 'not-found',
        );
      return `${type}/${found[0].id}`;
    };
    for (const [i, entry] of entries.entries()) {
      if (!entry.resource || entry.resource.resourceType === 'Binary') continue;
      for (const holder of referencesOf(entry.resource)) {
        const reference: string = holder.reference;
        const target = targets.get(reference);
        if (target) holder.reference = target;
        else if (/^[A-Z][A-Za-z]*\?/.test(reference)) {
          let r = resolved.get(reference);
          if (!r) resolved.set(reference, (r = await resolve(reference, i)));
          holder.reference = r;
        }
      }
    }
    return assigned;
  }

  /**
   * One entry of a batch or transaction, run as a request, its answer an
   * OperationOutcome when it fails. `assignedId`: the id a transaction gave
   * a new resource.
   */
  private async _entry(
    ctx: Exchange,
    entry: any,
    index: number,
    assignedId?: string,
  ): Promise<Response> {
    try {
      const request = this._entryRequest(ctx, entry, index);
      const url = new URL(request.url);
      const path = url.pathname.slice(this.base.length);
      const seg = path
        .split('/')
        .filter(Boolean)
        .map(s => decodeURIComponent(s));
      if (!seg.length)
        throw new FhirServerError(
          400,
          `Entry ${index}: a batch cannot hold a request on the server base`,
          'not-supported',
        );
      return await this._dispatch(
        {
          request,
          url,
          method: request.method,
          baseUrl: ctx.baseUrl,
          // the caller of the Bundle, the request of the entry
          context: { principal: ctx.context.principal, request },
          tx: ctx.tx,
          assignedId,
        },
        seg,
        path,
      );
    } catch (e) {
      if (!(e instanceof FhirServerError)) {
        this.options.onError?.(e, ctx.request);
        e = new FhirServerError(
          500,
          'The server could not answer the request',
          'exception',
        );
      }
      return outcomeResponse(e as FhirServerError);
    }
  }

  /** The request an entry stands for: its method, URL, conditions and resource */
  private _entryRequest(ctx: Exchange, entry: any, index: number): Request {
    const method = entryMethod(entry, index);
    const r = entry.request;
    const headers = new Headers({ Accept: FHIR_JSON });
    const prefer = ctx.request.headers.get('Prefer');
    if (prefer) headers.set('Prefer', prefer);
    if (typeof r.ifMatch === 'string') headers.set('If-Match', r.ifMatch);
    if (typeof r.ifNoneExist === 'string')
      headers.set('If-None-Exist', r.ifNoneExist);
    let body: string | undefined;
    const resource = entry.resource;
    if (method === 'PATCH') {
      // a JSON Patch is sent as a Binary, as the specification has it
      if (
        resource?.resourceType !== 'Binary' ||
        typeof resource.data !== 'string'
      )
        throw new FhirServerError(
          400,
          `Entry ${index}: a patch is a Binary with the JSON Patch as its data`,
          'required',
        );
      headers.set('Content-Type', 'application/json-patch+json');
      body = Buffer.from(resource.data, 'base64').toString('utf8');
    } else if (resource !== undefined) {
      headers.set('Content-Type', FHIR_JSON);
      body = stringifyJson(resource);
    }
    return new Request(`${ctx.baseUrl}/${r.url.replace(/^\/+/, '')}`, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Interactions                                                     */
  /* ---------------------------------------------------------------- */

  private async _read(
    ctx: Exchange,
    type: string,
    id: string,
    served: Served,
  ): Promise<Response> {
    const store = need(served, 'read', type);
    await this._authorize(ctx, 'read', type, id);
    const s = await store.read!(type, id, ctx.context);
    return this._found(ctx, 'read', s, `${type}/${id}`, served);
  }

  private async _vread(
    ctx: Exchange,
    type: string,
    id: string,
    vid: string,
    served: Served,
  ): Promise<Response> {
    const store = need(served, 'vread', type);
    await this._authorize(ctx, 'vread', type, id);
    const s = await store.vread!(type, id, vid, ctx.context);
    return this._found(
      ctx,
      'vread',
      s,
      `${type}/${id}/_history/${vid}`,
      served,
    );
  }

  /** A resource read: 404 when there is none, or the caller may not see it; 410 when deleted */
  private async _found(
    ctx: Exchange,
    interaction: FhirInteraction,
    s: StoredResource | undefined,
    what: string,
    served: Served,
  ): Promise<Response> {
    if (!s) throw new FhirServerError(404, `${what} is not known`, 'not-found');
    if (s.resource && !(await this._may(ctx, interaction, s.type, s.resource)))
      throw new FhirServerError(404, `${what} is not known`, 'not-found');
    if (!s.resource)
      throw new FhirServerError(410, `${what} was deleted`, 'deleted');
    const subset = subsetOf(
      ctx.url.searchParams,
      this.fhir,
      s.type,
      isStrict(ctx.request),
    );
    if (subset?.summary === 'count')
      throw new FhirServerError(
        400,
        '_summary=count is for a search, not a read',
        'not-supported',
      );
    return jsonResponse(
      200,
      subset
        ? JSON.stringify(subsetted(this._json(s), subset, this.fhir))
        : this._text(s),
      versionHeaders(s, served),
    );
  }

  private async _create(
    ctx: Exchange,
    type: string,
    served: Served,
  ): Promise<Response> {
    const store = need(served, 'create', type);
    await this._authorize(ctx, 'create', type);
    const { id: _ignored, ...resource } = await this._body(ctx, type);
    await this._guardWrite(ctx, 'create', type, undefined, resource, served);
    // If-None-Exist: create only when the criteria find nothing
    const ifNoneExist = ctx.request.headers.get('If-None-Exist');
    if (ifNoneExist !== null) {
      const found = await this._matchesOf(
        ctx,
        ifNoneExist.replace(/^\?/, ''),
        type,
        served,
        'Conditional create',
        'create',
      );
      if (found.length > 1)
        throw new FhirServerError(
          412,
          `If-None-Exist: ${ifNoneExist} finds more than one ${type}`,
          'multiple-matches',
        );
      if (found.length === 1)
        return this._written(ctx, { ...found[0], method: 'PUT' }, 200, served);
    }
    const s = await store.create!(
      type,
      ctx.assignedId ? { ...resource, id: ctx.assignedId } : resource,
      ctx.context,
    );
    return this._written(ctx, s, 201, served);
  }

  private async _update(
    ctx: Exchange,
    type: string,
    id: string,
    served: Served,
  ): Promise<Response> {
    need(served, 'update', type);
    await this._authorize(ctx, 'update', type, id);
    const resource = await this._body(ctx, type);
    if (resource.id === undefined)
      throw new FhirServerError(
        400,
        `The ${type} has no id; it must be ${id}`,
        'required',
      );
    if (resource.id !== id)
      throw new FhirServerError(
        400,
        `The ${type}'s id ${resource.id} is not the id of the URL, ${id}`,
        'invalid',
      );
    return this._store(ctx, 'update', type, id, resource, served);
  }

  /**
   * Writes a checked resource by update, when the caller may (the one it
   * replaces, and it); 405 when the id does not exist and the store does
   * not create by update
   */
  private async _store(
    ctx: Exchange,
    interaction: FhirInteraction,
    type: string,
    id: string,
    resource: Record<string, any>,
    served: Served,
  ): Promise<Response> {
    await this._guardWrite(ctx, interaction, type, id, resource, served);
    const s = await served.store.update!(
      type,
      id,
      resource,
      ifMatchOf(ctx.request, served),
      ctx.context,
    );
    if (!s)
      throw new FhirServerError(
        405,
        `${type}/${id} does not exist, and the server does not create resources by update`,
        'not-supported',
      );
    return this._written(ctx, s, s.method === 'POST' ? 201 : 200, served);
  }

  /**
   * PUT [type]?criteria: updates the one resource the criteria find, creates
   * one when they find none, refuses (412) when they find more
   */
  private async _conditionalUpdate(
    ctx: Exchange,
    type: string,
    served: Served,
  ): Promise<Response> {
    need(served, 'update', type);
    await this._authorize(ctx, 'update', type);
    const resource = await this._body(ctx, type);
    const found = await this._matchesOf(
      ctx,
      ctx.url.search.slice(1),
      type,
      served,
      'Conditional update',
      'update',
    );
    if (found.length > 1)
      throw new FhirServerError(
        412,
        `${ctx.url.search} finds more than one ${type}`,
        'multiple-matches',
      );
    if (found.length === 1) {
      const id = found[0].id;
      if (resource.id !== undefined && resource.id !== id)
        throw new FhirServerError(
          400,
          `The ${type}'s id ${resource.id} is not the id of the ${type} the criteria find, ${id}`,
          'invalid',
        );
      return this._store(ctx, 'update', type, id, { ...resource, id }, served);
    }
    // nothing found: created, with the id of the body when there is one
    if (resource.id !== undefined)
      return this._store(ctx, 'update', type, resource.id, resource, served);
    const store = need(served, 'create', type);
    await this._guardWrite(ctx, 'update', type, undefined, resource, served);
    return this._written(
      ctx,
      await store.create!(type, resource, ctx.context),
      201,
      served,
    );
  }

  private async _delete(
    ctx: Exchange,
    type: string,
    id: string,
    served: Served,
  ): Promise<Response> {
    const store = need(served, 'delete', type);
    await this._authorize(ctx, 'delete', type, id);
    await this._guardWrite(ctx, 'delete', type, id, undefined, served);
    await store.delete!(type, id, ifMatchOf(ctx.request, served), ctx.context);
    return new Response(null, { status: 204 });
  }

  /** DELETE [type]?criteria: the one resource they find; 412 when they find more */
  private async _conditionalDelete(
    ctx: Exchange,
    type: string,
    served: Served,
  ): Promise<Response> {
    const store = need(served, 'delete', type);
    await this._authorize(ctx, 'delete', type);
    const found = await this._matchesOf(
      ctx,
      ctx.url.search.slice(1),
      type,
      served,
      'Conditional delete',
      'delete',
    );
    if (found.length > 1)
      throw new FhirServerError(
        412,
        `${ctx.url.search} finds more than one ${type}`,
        'multiple-matches',
      );
    if (found.length === 1)
      await store.delete!(
        type,
        found[0].id,
        ifMatchOf(ctx.request, served),
        ctx.context,
      );
    return new Response(null, { status: 204 });
  }

  /**
   * PATCH [type]/[id] (or [type]?criteria: the one resource they find) with
   * a JSON Patch: applied to the current version, then checked and written
   * as an update
   */
  private async _patch(
    ctx: Exchange,
    type: string,
    id: string | undefined,
    served: Served,
  ): Promise<Response> {
    need(served, 'read', type);
    need(served, 'update', type);
    await this._authorize(ctx, 'patch', type, id);
    const mediaType = mediaTypeOf(ctx.request.headers.get('Content-Type'));
    if (mediaType !== 'application/json-patch+json')
      throw new FhirServerError(
        415,
        `A patch is sent as application/json-patch+json, not ${mediaType || 'no content type'}`,
        'not-supported',
      );
    let patch: unknown;
    try {
      patch = parseFhirJson(await ctx.request.text());
    } catch {
      throw new FhirServerError(400, 'The patch is not JSON', 'structure');
    }
    if (id === undefined) {
      const found = await this._matchesOf(
        ctx,
        ctx.url.search.slice(1),
        type,
        served,
        'Conditional patch',
        'patch',
      );
      if (found.length !== 1)
        throw new FhirServerError(
          found.length ? 412 : 404,
          `${ctx.url.search} finds ${found.length ? 'more than one' : 'no'} ${type}`,
          found.length ? 'multiple-matches' : 'not-found',
        );
      id = found[0].id;
    }
    const current = await served.store.read!(type, id, ctx.context);
    if (
      !current ||
      (current.resource &&
        !(await this._may(ctx, 'patch', type, current.resource)))
    )
      throw new FhirServerError(404, `${type}/${id} is not known`, 'not-found');
    if (!current.resource)
      throw new FhirServerError(410, `${type}/${id} was deleted`, 'deleted');
    const patched = applyJsonPatch(
      parseFhirJson(this._text(current)),
      patch,
    ) as Record<string, any>;
    if (
      !patched ||
      typeof patched !== 'object' ||
      patched.resourceType !== type ||
      patched.id !== id
    )
      throw new FhirServerError(
        422,
        `The patch must leave a ${type} with the id ${id}`,
        'processing',
      );
    return this._store(
      ctx,
      'patch',
      type,
      id,
      this._checked(patched, type),
      served,
    );
  }

  /**
   * POST [type]/$validate: the issues of a resource (or of the `resource`
   * of a Parameters), against the model and the profiles meta.profile and
   * `profile` name; nothing is stored. Always 200 with an OperationOutcome.
   */
  private async _validate(ctx: Exchange, type: string): Promise<Response> {
    await this._authorize(ctx, 'validate', type);
    const mediaType = mediaTypeOf(ctx.request.headers.get('Content-Type'));
    if (!mediaType || !JSON_TYPES.has(mediaType))
      throw new FhirServerError(
        415,
        `A resource is sent as ${FHIR_JSON}, not ${mediaType || 'no content type'}`,
        'not-supported',
      );
    let body: any;
    try {
      body = parseFhirJson(await ctx.request.text());
    } catch {
      throw new FhirServerError(400, 'The body is not JSON', 'structure');
    }
    const profiles = ctx.url.searchParams.getAll('profile');
    if (body?.resourceType === 'Parameters' && type !== 'Parameters') {
      const params: any[] = Array.isArray(body.parameter) ? body.parameter : [];
      for (const p of params)
        if (p?.name === 'profile') {
          const v = p.valueUri ?? p.valueCanonical;
          if (typeof v === 'string') profiles.push(v);
        }
      body = params.find(p => p?.name === 'resource')?.resource;
    }
    if (!body || typeof body !== 'object' || body.resourceType !== type)
      throw new FhirServerError(
        400,
        `$validate takes a ${type}, or a Parameters with a ${type} as resource`,
        'invalid',
      );
    for (const url of profiles)
      if (!this.fhir.model.findProfile(url))
        throw new FhirServerError(
          400,
          `profile: ${url} is not known to the server`,
          'not-supported',
        );
    const result = this.fhir.validate(
      body,
      undefined,
      profiles.length ? { profile: profiles } : {},
    );
    return jsonResponse(200, JSON.stringify(result.outcome()));
  }

  /** The answer to a create or update, as the Prefer header asks */
  private _written(
    ctx: Exchange,
    s: StoredVersion,
    status: number,
    served: Served,
  ): Response {
    const headers = versionHeaders(s, served);
    if (status === 201)
      headers.Location =
        `${ctx.baseUrl}/${s.type}/${s.id}` +
        (s.versionId !== undefined && served.caps.versions !== 'none'
          ? `/_history/${s.versionId}`
          : '');
    switch (preferReturn(ctx.request)) {
      case 'minimal':
        return new Response(null, { status, headers });
      case 'OperationOutcome':
        return jsonResponse(
          status,
          JSON.stringify({
            resourceType: 'OperationOutcome',
            issue: [
              {
                severity: 'information',
                code: 'informational',
                diagnostics: `${s.type}/${s.id} ${status === 201 ? 'created' : 'updated'}`,
              },
            ],
          }),
          headers,
        );
      default:
        return jsonResponse(status, this._text(s), headers);
    }
  }

  private async _history(
    ctx: Exchange,
    served: Served,
    type: string | undefined,
    id: string | undefined,
  ): Promise<Response> {
    const store = need(served, 'history', type ?? 'the server');
    await this._authorize(ctx, 'history', type, id);
    const q = ctx.url.searchParams;
    const count = Math.min(
      intParam(q, '_count') ?? this.options.defaultCount ?? 50,
      this.options.maxCount ?? 500,
    );
    const offset = intParam(q, '_offset') ?? 0;
    const since = q.get('_since') ?? undefined;
    if (since !== undefined && Number.isNaN(Date.parse(since)))
      throw new FhirServerError(
        400,
        `_since: "${since}" is not an instant`,
        'value',
      );
    const page = await store.history!(
      type,
      id,
      { since, count, offset },
      ctx.context,
    );
    // the versions the caller may not see are left out (a deleted one, which
    // cannot be checked, too, when the authorizer checks resources)
    if (this.options.security?.authorizer?.authorizeResource) {
      const kept: StoredVersion[] = [];
      for (const v of page.items)
        if (v.resource && (await this._may(ctx, 'history', v.type, v.resource)))
          kept.push(v);
      page.items = kept;
    }

    const path = `${ctx.baseUrl}/${[type, id, '_history'].filter(Boolean).join('/')}`;
    const link = (rel: string, at: number) => {
      const p = new URLSearchParams();
      if (since) p.set('_since', since);
      p.set('_count', String(count));
      if (at) p.set('_offset', String(at));
      return { relation: rel, url: `${path}?${p}` };
    };
    const more =
      page.total !== undefined
        ? offset + count < page.total
        : page.items.length === count;
    const links = [link('self', offset)];
    if (count && more) links.push(link('next', offset + count));
    if (offset) links.push(link('previous', Math.max(0, offset - count)));

    const bundle: Record<string, any> = {
      resourceType: 'Bundle',
      type: 'history',
    };
    if (page.total !== undefined) bundle.total = page.total;
    bundle.link = links;
    bundle.entry = page.items.map(v => {
      const entry: Record<string, any> = {
        fullUrl: `${ctx.baseUrl}/${v.type}/${v.id}`,
      };
      if (v.resource) entry.resource = this._json(v);
      entry.request = {
        method: v.method,
        url: v.method === 'POST' ? v.type : `${v.type}/${v.id}`,
      };
      entry.response = { status: STATUS_LINE[v.method] };
      if (v.versionId !== undefined) entry.response.etag = `W/"${v.versionId}"`;
      if (v.lastUpdated) entry.response.lastModified = v.lastUpdated;
      return entry;
    });
    if (!bundle.entry.length) delete bundle.entry;
    return jsonResponse(200, JSON.stringify(bundle));
  }

  /**
   * GET [type]?params, POST [type]/_search: the matches, a page at a time,
   * in a searchset Bundle. A parameter the server does not know, or the
   * store does not answer, is left out (and out of the self link), or
   * refused with Prefer: handling=strict.
   */
  private async _search(
    ctx: Exchange,
    type: string,
    served: Served,
  ): Promise<Response> {
    const store = need(served, 'search', type);
    const params = new URLSearchParams(ctx.url.search);
    if (ctx.method === 'POST') {
      const mediaType = mediaTypeOf(ctx.request.headers.get('Content-Type'));
      if (mediaType !== 'application/x-www-form-urlencoded')
        throw new FhirServerError(
          415,
          `_search takes a form (application/x-www-form-urlencoded), not ${mediaType || 'no content type'}`,
          'not-supported',
        );
      for (const [k, v] of new URLSearchParams(await ctx.request.text()))
        params.append(k, v);
    }
    const strict = isStrict(ctx.request);
    const subset = subsetOf(params, this.fhir, type, strict);
    const decision = await this._authorize(ctx, 'search', type);
    const { query, applied } = this._query(
      params,
      type,
      served,
      ctx.baseUrl,
      strict,
    );
    // the authorizer's criteria: AND, read strictly, not in the links
    if (decision?.criteria)
      query.criteria.push(
        ...this._query(
          new URLSearchParams(decision.criteria),
          type,
          served,
          ctx.baseUrl,
          true,
        ).query.criteria,
      );
    await this._authorizeChains(ctx, query.criteria);
    const includes =
      subset?.summary === 'count'
        ? []
        : this._includeSpecs(params, strict, applied);
    if (subset)
      for (const name of ['_summary', '_elements'])
        for (const v of params.getAll(name)) applied.append(name, v);
    const { count, offset } = query;
    const baseUrl = ctx.baseUrl;
    const page = await store.search!(type, query, ctx.context);
    const included = includes.length
      ? await this._included(ctx, page.items, includes)
      : { items: [], complete: true };

    const link = (rel: string, at: number) => {
      const p = new URLSearchParams(applied);
      p.set('_count', String(count));
      if (at) p.set('_offset', String(at));
      return { relation: rel, url: `${baseUrl}/${type}?${p}` };
    };
    const more =
      page.total !== undefined
        ? offset + count < page.total
        : page.items.length === count;
    const links = [link('self', offset)];
    if (count && more) links.push(link('next', offset + count));
    if (offset) links.push(link('previous', Math.max(0, offset - count)));
    const bundle: Record<string, any> = {
      resourceType: 'Bundle',
      type: 'searchset',
    };
    if (page.total !== undefined) bundle.total = page.total;
    bundle.link = links;
    // _summary=count: the total alone
    const matches = subset?.summary === 'count' ? [] : page.items;
    const json = (s: StoredResource) =>
      subset ? subsetted(this._json(s), subset, this.fhir) : this._json(s);
    const entry = [
      ...matches.map(s => ({
        fullUrl: `${baseUrl}/${s.type}/${s.id}`,
        resource: json(s),
        search: { mode: 'match' },
      })),
      ...included.items.map(s => ({
        fullUrl: `${baseUrl}/${s.type}/${s.id}`,
        resource: json(s),
        search: { mode: 'include' },
      })),
    ];
    if (!included.complete)
      entry.push({
        resource: {
          resourceType: 'OperationOutcome',
          issue: [
            {
              severity: 'warning',
              code: 'too-costly',
              diagnostics: `More resources are included than this server gives (${this.options.maxIncludes ?? 1000}); the rest are left out`,
            },
          ],
        },
        search: { mode: 'outcome' },
      } as any);
    if (entry.length) bundle.entry = entry;
    return jsonResponse(200, JSON.stringify(bundle));
  }

  /**
   * _include and _revinclude (and their :iterate), read: `Type:parameter`
   * or `Type:parameter:TargetType`. Those the server cannot follow are
   * unknown parameters: left out of `applied`, or refused when strict.
   */
  private _includeSpecs(
    params: URLSearchParams,
    strict: boolean,
    applied: URLSearchParams,
  ): IncludeSpec[] {
    const model = this.fhir.model;
    const specs: IncludeSpec[] = [];
    for (const [name, value] of params) {
      const [what, modifier] = name.split(':');
      if (what !== '_include' && what !== '_revinclude') continue;
      const rev = what === '_revinclude';
      const [source, code, target, ...extra] = value.split(':');
      let why: string | undefined;
      const param =
        source && code ? model.getSearchParameter(source, code) : undefined;
      if (!source || !code || extra.length)
        why = `${name}=${value}: it takes [type]:[parameter] or [type]:[parameter]:[target type]`;
      else if (param?.type !== 'reference' || !param.expression)
        why = `${name}=${value}: ${source} has no reference parameter ${code}`;
      else if (
        target !== undefined &&
        (!model.resourceTypes().includes(target) ||
          (param.target?.length && !param.target.includes(target)))
      )
        why = `${name}=${value}: ${source}.${code} does not refer to ${target}`;
      else if (rev && !this._served.get(source)?.params.has(code))
        why = `${name}=${value}: ${source} cannot be searched by ${code}`;
      else if (modifier !== undefined && modifier !== 'iterate')
        why = `${name}: the modifier is not supported`;
      if (why) {
        if (strict) throw new FhirServerError(400, why, 'not-supported');
        continue;
      }
      specs.push({
        rev,
        iterate: modifier === 'iterate',
        source,
        param: param!,
        target,
      });
      applied.append(name, value);
    }
    return specs;
  }

  /**
   * The resources a page's matches include: those they refer to (_include)
   * and those that refer to them (_revinclude), each once; then, for the
   * :iterate ones, those the included ones include, up to MAX_ITERATE
   * rounds. The resources the caller may not see are left out. At most
   * maxIncludes; `complete` is false when there were more.
   */
  private async _included(
    ctx: Exchange,
    matches: StoredResource[],
    specs: IncludeSpec[],
  ): Promise<{ items: StoredResource[]; complete: boolean }> {
    const max = this.options.maxIncludes ?? 1000;
    const seen = new Set(matches.map(s => `${s.type}/${s.id}`));
    const items: StoredResource[] = [];
    let complete = true;
    let frontier = matches;
    for (let round = 0; round <= MAX_ITERATE && frontier.length; round++) {
      const found: StoredResource[] = [];
      const add = (s: StoredResource) => {
        const key = `${s.type}/${s.id}`;
        if (seen.has(key)) return;
        if (items.length >= max) {
          complete = false;
          return;
        }
        seen.add(key);
        items.push(s);
        found.push(s);
      };
      for (const spec of specs) {
        if (round > 0 && !spec.iterate) continue;
        if (!spec.rev) {
          for (const r of frontier) {
            if (r.type !== spec.source || !r.resource) continue;
            for (const ref of this._matcher.references(
              r.resource,
              spec.param,
              ctx.baseUrl,
            )) {
              const [type, id] = ref.split('/');
              if (seen.has(ref) || (spec.target && type !== spec.target))
                continue;
              const s = await this._includable(ctx, type, id);
              if (s) add(s);
            }
          }
          continue;
        }
        // _revinclude: a search of the source type for references to the frontier
        const values: SearchValue[] = frontier
          .filter(
            r =>
              r.resource &&
              (!spec.target || r.type === spec.target) &&
              (!spec.param.target?.length ||
                spec.param.target.includes(r.type)),
          )
          .map(r => ({ raw: `${r.type}/${r.id}`, type: r.type, id: r.id }));
        if (!values.length) continue;
        const d = await this._decision(ctx, 'search', spec.source);
        if (!d.allowed) continue;
        const served = this._servedOf(ctx, spec.source)!;
        const { query } = this._query(
          new URLSearchParams(d.criteria ?? ''),
          spec.source,
          served,
          ctx.baseUrl,
          true,
        );
        query.criteria.push({ param: spec.param, values });
        query.count = max - items.length + 1;
        const page = await served.store.search!(
          spec.source,
          query,
          ctx.context,
        );
        for (const s of page.items)
          if (
            s.resource &&
            (await this._may(ctx, 'search', s.type, s.resource))
          )
            add(s);
        if (page.total !== undefined && page.total > page.items.length)
          complete = false;
      }
      frontier = found;
    }
    return { items, complete };
  }

  /** A resource to include, when it is served, exists and the caller may read it */
  private async _includable(
    ctx: Exchange,
    type: string,
    id: string,
  ): Promise<StoredResource | undefined> {
    const served = this._servedOf(ctx, type);
    if (
      !served ||
      !served.caps.interactions.includes('read') ||
      typeof served.store.read !== 'function'
    )
      return;
    if (!(await this._decision(ctx, 'read', type, id)).allowed) return;
    const s = await served.store.read(type, id, ctx.context);
    if (!s?.resource || !(await this._may(ctx, 'read', type, s.resource)))
      return;
    return s;
  }

  /**
   * The search a URL's parameters ask for, and the parameters applied (for
   * the links). Unknown parameters are left out, or refused when strict.
   */
  private _query(
    params: URLSearchParams,
    type: string,
    served: Served,
    baseUrl: string,
    strict: boolean,
  ): { query: SearchQuery; applied: URLSearchParams } {
    const criteria: SearchCriterion[] = [];
    const applied = new URLSearchParams();
    for (const [name, value] of params) {
      if (RESULT_PARAMS.has(name.split(':')[0])) continue;
      const c = this._criterion(name, value, type, served, 0);
      if (typeof c === 'string') {
        if (strict)
          throw new FhirServerError(
            400,
            name.includes('.') || name.startsWith('_has:')
              ? `${name}: ${c}`
              : c,
            'not-supported',
          );
        continue;
      }
      localReferences(c, baseUrl);
      criteria.push(c);
      applied.append(name, value);
    }
    // _sort=-date,name: the parameters the store can sort by
    const sort: SearchSort[] = [];
    for (const item of params.getAll('_sort').flatMap(s => s.split(','))) {
      const descending = item.startsWith('-');
      const code = descending ? item.slice(1) : item;
      const param = served.params.get(code);
      if (
        !param ||
        param.type === 'composite' ||
        (served.caps.sort && !served.caps.sort.includes(code))
      ) {
        if (strict)
          throw new FhirServerError(
            400,
            `${type} cannot be sorted by ${code}`,
            'not-supported',
          );
        continue;
      }
      sort.push({ param, descending });
    }
    if (sort.length)
      applied.set(
        '_sort',
        sort.map(s => (s.descending ? '-' : '') + s.param.code).join(','),
      );
    const count = Math.min(
      intParam(params, '_count') ?? this.options.defaultCount ?? 50,
      this.options.maxCount ?? 500,
    );
    const offset = intParam(params, '_offset') ?? 0;
    const query: SearchQuery = {
      type,
      criteria,
      count,
      offset,
      sort,
      matches: (resource, lookup) =>
        this._matcher.matches(resource, criteria, baseUrl, lookup),
      compare: (a, b) => this._matcher.compare(a, b, sort),
    };
    return { query, applied };
  }

  /**
   * One parameter of a search on a type: a criterion, chained
   * (`subject:Patient.name`) or reverse-chained (`_has:Observation:patient:code`)
   * when the store answers chains, or why it is not one the server can take
   * (an unknown parameter). Throws 400 for one it cannot read.
   */
  private _criterion(
    name: string,
    value: string,
    type: string,
    served: Served,
    depth: number,
  ): SearchCriterion | string {
    const model = this.fhir.model;
    const isResourceType = (t: string) => model.resourceTypes().includes(t);
    if (name.startsWith('_has:')) {
      const [, from, code, ...rest] = name.split(':');
      if (!from || !code || !rest.length)
        throw new FhirServerError(
          400,
          `${name}: _has takes _has:[type]:[parameter]:[criterion]`,
          'value',
        );
      const why = this._chainable(type, from, depth);
      if (why) return why;
      const fromServed = this._served.get(from)!;
      const param = fromServed.params.get(code);
      if (param?.type !== 'reference')
        return `${from} cannot be searched by a reference parameter ${code}`;
      if (param.target?.length && !param.target.includes(type))
        return `${from}.${code} does not refer to ${type}`;
      const inner = this._criterion(
        rest.join(':'),
        value,
        from,
        fromServed,
        depth + 1,
      );
      if (typeof inner === 'string') return inner;
      return { param, values: [], has: { type: from, criteria: [inner] } };
    }
    const dot = name.indexOf('.');
    if (dot > 0) {
      const head = name.slice(0, dot);
      const rest = name.slice(dot + 1);
      const colon = head.indexOf(':');
      const code = colon < 0 ? head : head.slice(0, colon);
      const modifier = colon < 0 ? undefined : head.slice(colon + 1);
      const param = served.params.get(code);
      if (param?.type !== 'reference')
        return `${type} cannot be searched by a reference parameter ${code}`;
      let target = modifier;
      if (target !== undefined) {
        if (
          !isResourceType(target) ||
          (param.target?.length && !param.target.includes(target))
        )
          throw new FhirServerError(
            400,
            `${name}: ${type}.${code} does not refer to ${target}`,
            'value',
          );
      } else {
        // the one type it refers to that can be searched by the next link
        const next = rest.startsWith('_has:') ? '_id' : rest.split(/[.:]/)[0];
        const targets = (param.target ?? []).filter(t =>
          this._served.get(t)?.params.has(next),
        );
        if (targets.length > 1)
          throw new FhirServerError(
            400,
            `${name}: ${type}.${code} refers to ${targets.join(', ')}; name the type, as ${code}:${targets[0]}.${rest}`,
            'value',
          );
        if (!targets.length)
          return `no type ${type}.${code} refers to can be searched by ${next}`;
        target = targets[0];
      }
      const why = this._chainable(type, target, depth);
      if (why) return why;
      const inner = this._criterion(
        rest,
        value,
        target,
        this._served.get(target)!,
        depth + 1,
      );
      if (typeof inner === 'string') return inner;
      return {
        param,
        modifier: target,
        values: [],
        chain: { type: target, criteria: [inner] },
      };
    }
    const colon = name.indexOf(':');
    const code = colon < 0 ? name : name.slice(0, colon);
    const modifier = colon < 0 ? undefined : name.slice(colon + 1);
    const param = served.params.get(code);
    if (!param) return `Unknown search parameter ${name} for ${type}`;
    return parseCriterion(
      param,
      modifier,
      value,
      isResourceType,
      served.components.get(code),
    );
  }

  /** Why a chain from a type to another cannot be searched; undefined when it can */
  private _chainable(
    from: string,
    to: string,
    depth: number,
  ): string | undefined {
    if (depth >= MAX_CHAIN) return `a chain has ${MAX_CHAIN} links at most`;
    const chains = this._served.get(from)!.caps.chains;
    if (!chains)
      return `the store of ${from} does not answer chained parameters`;
    const target = this._served.get(to);
    if (!target) return `${to} is not served`;
    if (chains !== true && !chains(to))
      return `the store of ${from} does not answer chains to ${to}`;
    if (!target.caps.interactions.includes('search'))
      return `${to} cannot be searched`;
  }

  /**
   * Authorizes the types chains go to, as searches (403 when one is not
   * allowed), and adds the authorizer's criteria for them to their chains:
   * a chain finds nothing the caller could not find by searching
   */
  private async _authorizeChains(
    ctx: Exchange,
    criteria: readonly SearchCriterion[],
  ): Promise<void> {
    for (const c of criteria) {
      const chain = c.chain ?? c.has;
      if (!chain) continue;
      await this._authorizeChains(ctx, chain.criteria);
      const d = await this._authorize(ctx, 'search', chain.type);
      if (d?.criteria)
        chain.criteria.push(
          ...this._query(
            new URLSearchParams(d.criteria),
            chain.type,
            this._served.get(chain.type)!,
            ctx.baseUrl,
            true,
          ).query.criteria,
        );
    }
  }

  /**
   * The resources a conditional interaction's criteria find, two at most
   * (one is all it needs to know). The criteria are read strictly: an
   * unknown parameter would widen them. 405 when the store cannot search.
   */
  private async _matchesOf(
    ctx: Exchange,
    criteria: string,
    type: string,
    served: Served,
    what: string,
    interaction: FhirInteraction,
  ): Promise<StoredResource[]> {
    const params = new URLSearchParams(criteria);
    if (!params.size)
      throw new FhirServerError(
        400,
        `${what} needs search criteria`,
        'required',
      );
    if (
      !served.caps.interactions.includes('search') ||
      typeof served.store.search !== 'function'
    )
      throw new FhirServerError(
        405,
        `${what} is not supported for ${type}: its store cannot search`,
        'not-supported',
      );
    const { query } = this._query(params, type, served, ctx.baseUrl, true);
    await this._authorizeChains(ctx, query.criteria);
    query.count = 2;
    query.offset = 0;
    const page = await served.store.search(type, query, ctx.context);
    const found: StoredResource[] = [];
    for (const s of page.items)
      if (s.resource && (await this._may(ctx, interaction, type, s.resource)))
        found.push(s);
    return found;
  }

  /* ---------------------------------------------------------------- */
  /* Security                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * The caller: the first authenticator that finds one (a refusal stops
   * the chain with 401). Without one, 401 with every challenge, or nobody
   * with anonymous. Undefined on a server without security.
   */
  private async _authenticate(
    ctx: Exchange,
  ): Promise<FhirPrincipal | undefined> {
    const security = this.options.security;
    if (!security) return;
    for (const a of security.authenticators) {
      const p = await a.authenticate(ctx.request, { baseUrl: ctx.baseUrl });
      if (p) return p;
    }
    if (security.anonymous) return;
    const e = new FhirServerError(401, 'Authentication is required', 'login');
    const challenges = security.authenticators
      .map(a => a.challenge)
      .filter((c): c is string => !!c);
    e.headers = { 'WWW-Authenticate': challenges.join(', ') || 'Bearer' };
    throw e;
  }

  /** The authorizer's decision, allowed or not; allowed without one */
  private async _decision(
    ctx: Exchange,
    interaction: FhirInteraction,
    type?: string,
    id?: string,
  ): Promise<FhirAccessDecision> {
    const authorizer = this.options.security?.authorizer;
    if (!authorizer) return { allowed: true };
    return authorizer.authorize({
      principal: ctx.context.principal,
      interaction,
      type,
      id,
    });
  }

  /** The authorizer's decision (403 when not allowed); undefined without one */
  private async _authorize(
    ctx: Exchange,
    interaction: FhirInteraction,
    type?: string,
    id?: string,
  ): Promise<FhirAccessDecision | undefined> {
    const authorizer = this.options.security?.authorizer;
    if (!authorizer) return;
    const d = await authorizer.authorize({
      principal: ctx.context.principal,
      interaction,
      type,
      id,
    });
    if (!d.allowed)
      throw new FhirServerError(
        403,
        d.reason ?? `${interaction} of ${type ?? 'the server'} is not allowed`,
        'forbidden',
      );
    return d;
  }

  /** Whether the caller may see or write a resource (every one, without an authorizer that checks) */
  private async _may(
    ctx: Exchange,
    interaction: FhirInteraction,
    type: string,
    resource: Record<string, any>,
  ): Promise<boolean> {
    const authorizer = this.options.security?.authorizer;
    if (!authorizer?.authorizeResource) return true;
    return authorizer.authorizeResource(
      { principal: ctx.context.principal, interaction, type, id: resource.id },
      resource,
    );
  }

  /**
   * Before a write: the resource it replaces (404 when the caller may not
   * see it) and the resource written (403 when they may not write it)
   */
  private async _guardWrite(
    ctx: Exchange,
    interaction: FhirInteraction,
    type: string,
    id: string | undefined,
    resource: Record<string, any> | undefined,
    served: Served,
  ): Promise<void> {
    if (!this.options.security?.authorizer?.authorizeResource) return;
    if (id !== undefined && typeof served.store.read === 'function') {
      const current = await served.store.read(type, id, ctx.context);
      if (
        current?.resource &&
        !(await this._may(ctx, interaction, type, current.resource))
      )
        throw new FhirServerError(
          404,
          `${type}/${id} is not known`,
          'not-found',
        );
    }
    if (resource && !(await this._may(ctx, interaction, type, resource)))
      throw new FhirServerError(
        403,
        `The ${type} is not one the caller may write`,
        'forbidden',
      );
  }

  /**
   * The store as system history sees it: with history when every type
   * served declares history
   */
  private _systemStore(): Served {
    const all = [...this._served.values()];
    const history =
      all.length > 0 && all.every(s => s.caps.interactions.includes('history'));
    return {
      store: this._main,
      caps: { interactions: history ? ['history'] : [], versions: 'all' },
      params: new Map(),
      components: new Map(),
    };
  }

  /** A type as an exchange sees it: in a transaction, through its view of the store */
  private _servedOf(ctx: Exchange, type: string): Served | undefined {
    const served = this._served.get(type);
    return served && this._inTx(ctx, served);
  }

  private _inTx(ctx: Exchange, served: Served): Served {
    return ctx.tx ? { ...served, store: ctx.tx } : served;
  }

  /* ---------------------------------------------------------------- */
  /* Bodies                                                           */
  /* ---------------------------------------------------------------- */

  /** The resource of a write, checked against the model; its JSON form */
  private async _body(
    ctx: Exchange,
    type: string,
  ): Promise<Record<string, any>> {
    return this._checked(await this._readResource(ctx, type), type);
  }

  /** The body: a JSON resource of the type, not yet checked */
  private async _readResource(
    ctx: Exchange,
    type: string,
  ): Promise<Record<string, any>> {
    const mediaType = mediaTypeOf(ctx.request.headers.get('Content-Type'));
    if (!mediaType || !JSON_TYPES.has(mediaType))
      throw new FhirServerError(
        415,
        `A resource is sent as ${FHIR_JSON}, not ${mediaType || 'no content type'}`,
        'not-supported',
      );
    const text = await ctx.request.text();
    let json: any;
    try {
      json = parseFhirJson(text);
    } catch {
      throw new FhirServerError(400, 'The body is not JSON', 'structure');
    }
    if (!json || typeof json !== 'object' || Array.isArray(json))
      throw new FhirServerError(400, 'The body is not a resource', 'structure');
    if (json.resourceType !== type)
      throw new FhirServerError(
        400,
        `The body is a ${json.resourceType ?? 'resource without resourceType'}, not a ${type}`,
        'invalid',
      );
    return json;
  }

  /** A resource checked against the model (422 with its issues), in the JSON form the model writes */
  private _checked(
    json: Record<string, any>,
    type: string,
  ): Record<string, any> {
    const result = this.fhir.validate(json);
    if (!result.valid)
      throw new FhirServerError(
        422,
        `The ${type} is not valid`,
        'invalid',
        result.issues.map(i => ({
          severity: i.severity,
          code: i.code,
          diagnostics: i.diagnostics,
          ...(i.expression ? { expression: [i.expression] } : {}),
        })),
      );
    return this.fhir.encode(result.value, undefined, { rawDecimals: true });
  }

  /** A stored resource as the model writes it, checked: a store's mapping errors show here */
  private _json(s: StoredResource): Record<string, any> {
    try {
      const value = this.fhir.decode(s.resource!, s.type);
      return this.fhir.encode(value, undefined, { rawDecimals: true });
    } catch (e) {
      throw new FhirServerError(
        500,
        `The store gave a ${s.type}/${s.id} the model does not read: ${(e as Error).message}`,
        'exception',
      );
    }
  }

  private _text(s: StoredResource): string {
    return JSON.stringify(this._json(s));
  }

  /* ---------------------------------------------------------------- */
  /* Bulk Data export                                                 */
  /* ---------------------------------------------------------------- */

  /** $export, its status and its files; undefined for another path */
  private async _export(
    ctx: Exchange,
    seg: string[],
  ): Promise<Response | undefined> {
    const x = this.bulkExport!;
    const { method } = ctx;
    const principal = ctx.context.principal;
    const kickOff = (level: 'system' | 'patient' | 'group', group?: string) => {
      if (method !== 'GET' && method !== 'POST')
        throw notAllowed(method, '$export');
      return x.kickOff(
        ctx.request,
        ctx.url,
        ctx.baseUrl,
        ctx.context,
        level,
        group,
      );
    };
    if (seg.length === 1 && seg[0] === '$export') return kickOff('system');
    if (seg.length === 2 && seg[0] === 'Patient' && seg[1] === '$export')
      return kickOff('patient');
    if (seg.length === 3 && seg[0] === 'Group' && seg[2] === '$export') {
      if (!ID.test(seg[1]))
        throw new FhirServerError(400, `"${seg[1]}" is not an id`, 'value');
      return kickOff('group', seg[1]);
    }
    if (seg.length === 2 && seg[0] === '$export-status') {
      if (method === 'GET') return x.status(seg[1], ctx.baseUrl, principal);
      if (method === 'DELETE') return x.cancel(seg[1], principal);
      throw notAllowed(method, 'an export');
    }
    if (seg.length === 3 && seg[0] === '$export-file') {
      if (method !== 'GET') throw notAllowed(method, 'an export file');
      return x.file(seg[1], seg[2], principal);
    }
    return;
  }

  /** What $export asks of the server: searches as the caller of the kick-off */
  private _exportHost(): ExportHost {
    const searchable = (type: string) => {
      const served = this._served.get(type);
      return served &&
        served.caps.interactions.includes('search') &&
        typeof served.store.search === 'function'
        ? served
        : undefined;
    };
    const decision = (principal: FhirPrincipal | undefined, type: string) =>
      this.options.security?.authorizer
        ? this.options.security.authorizer.authorize({
            principal,
            interaction: 'search',
            type,
          })
        : Promise.resolve<FhirAccessDecision>({ allowed: true });
    return {
      searchable: () => [...this._served.keys()].filter(t => searchable(t)),
      hasParam: (type, code) => !!searchable(type)?.params.has(code),
      compartmentParams: type =>
        this.fhir.model.compartmentParams('Patient', type) ?? [],
      authorize: decision,
      search: async (type, params, count, offset, context) => {
        const served = searchable(type)!;
        const d = await decision(context.principal, type);
        if (!d.allowed)
          throw new FhirServerError(
            403,
            d.reason ?? `Export of ${type} is not allowed`,
            'forbidden',
          );
        const all = new URLSearchParams(params);
        if (d.criteria)
          for (const [k, v] of new URLSearchParams(d.criteria))
            all.append(k, v);
        const { query } = this._query(all, type, served, '', true);
        query.count = count;
        query.offset = offset;
        return served.store.search!(type, query, context);
      },
      read: async (type, id, context) => {
        const served = this._served.get(type);
        if (
          !served?.caps.interactions.includes('read') ||
          typeof served.store.read !== 'function'
        )
          return;
        const ctx = { context } as Exchange;
        if (!(await this._decision(ctx, 'read', type, id)).allowed) return;
        const s = await served.store.read(type, id, context);
        if (!s?.resource) return;
        if (!(await this._may(ctx, 'read', type, s.resource))) return;
        return s.resource;
      },
      json: s => this._json(s),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Capabilities                                                     */
  /* ---------------------------------------------------------------- */

  /** The CapabilityStatement: what each type's store declares */
  capabilityStatement(baseUrl: string): Record<string, any> {
    const resource = [...this._served].map(
      ([type, { store, caps, params }]) => {
        const interactions = caps.interactions.filter(
          i => METHOD[i] && typeof store[METHOD[i]!] === 'function',
        );
        const has = (i: FhirStoreInteraction) => interactions.includes(i);
        const codes = interactions.flatMap(i => CAPABILITY_CODES[i]);
        // PATCH reads the current version and writes it by update
        if (has('read') && has('update'))
          codes.splice(codes.indexOf('update') + 1, 0, 'patch');
        const r: Record<string, any> = {
          type,
          interaction: codes.map(code => ({ code })),
          versioning:
            caps.versions === 'none' ? 'no-version' : 'versioned-update',
          readHistory:
            caps.versions === 'all' && caps.interactions.includes('vread'),
          updateCreate: !!caps.updateCreate,
          // conditional interactions search first
          conditionalCreate: has('create') && has('search'),
          conditionalUpdate: has('update') && has('search'),
          conditionalDelete:
            has('delete') && has('search') ? 'single' : 'not-supported',
        };
        if (interactions.includes('search') && params.size)
          r.searchParam = [...params.values()].map(p => ({
            name: p.code,
            definition: p.url,
            type: p.type,
          }));
        r.operation = [
          {
            name: 'validate',
            definition:
              'http://hl7.org/fhir/OperationDefinition/Resource-validate',
          },
        ];
        if (this.bulkExport && (type === 'Patient' || type === 'Group'))
          r.operation.push({
            name: 'export',
            definition: `${BULK_DATA}/OperationDefinition/${type === 'Patient' ? 'patient' : 'group'}-export`,
          });
        return r;
      },
    );
    const rest: Record<string, any> = { mode: 'server' };
    const security = this.options.security;
    if (security) {
      rest.security = {
        service: [
          {
            coding: [
              {
                system:
                  'http://terminology.hl7.org/CodeSystem/restful-security-service',
                code: 'SMART-on-FHIR',
              },
            ],
          },
        ],
      };
      // the OAuth endpoints, as SMART's extension gives them
      const smart = security.smartConfiguration ?? {};
      const uris: [string, string][] = [];
      for (const [url, value] of [
        ['authorize', smart.authorization_endpoint],
        ['token', smart.token_endpoint],
        ['revoke', smart.revocation_endpoint],
        ['introspect', smart.introspection_endpoint],
      ] as const)
        if (typeof value === 'string') uris.push([url, value]);
      if (uris.length)
        rest.security.extension = [
          {
            url: 'http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris',
            extension: uris.map(([url, valueUri]) => ({ url, valueUri })),
          },
        ];
    }
    rest.resource = resource;
    if (this.bulkExport)
      rest.operation = [
        {
          name: 'export',
          definition: `${BULK_DATA}/OperationDefinition/export`,
        },
      ];
    rest.interaction = [{ code: 'batch' }];
    if (this._main.transaction) rest.interaction.push({ code: 'transaction' });
    if (
      this._systemStore().caps.interactions.includes('history') &&
      typeof this._main.history === 'function'
    )
      rest.interaction.push({ code: 'history-system' });
    return {
      resourceType: 'CapabilityStatement',
      status: 'active',
      date: this._date,
      kind: 'instance',
      ...(this.bulkExport && {
        instantiates: [`${BULK_DATA}/CapabilityStatement/bulk-data`],
      }),
      software: { name: this.options.name ?? '@fhirjs/server' },
      implementation: { description: 'FHIR server', url: baseUrl },
      fhirVersion: this.fhir.model.fhirVersion,
      format: ['json'],
      rest: [rest],
    };
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** An _include or _revinclude */
interface IncludeSpec {
  rev: boolean;
  iterate: boolean;
  /** The type that refers: of the matches for _include, of the included for _revinclude */
  source: string;
  /** Its reference parameter */
  param: FhirSearchParameter;
  /** The type referred to, when named */
  target?: string;
}

interface Exchange {
  request: Request;
  url: URL;
  method: string;
  /** The server's base URL: 'http://host/fhir' */
  baseUrl: string;
  /** What stores are told: the request, and its caller once authenticated */
  context: FhirRequestContext;
  /** In a transaction: the view of the store the entries go through */
  tx?: FhirStore;
  /** The id a transaction gave the resource an entry creates */
  assignedId?: string;
}

/** Prefer: handling=strict: unknown parameters are refused, not left out */
function isStrict(request: Request): boolean {
  return /(?:^|[;,\s])handling=strict\b/.test(
    request.headers.get('Prefer') ?? '',
  );
}

/** The method of a batch or transaction entry, its URL checked (400 otherwise) */
function entryMethod(entry: any, index: number): string {
  const r = entry?.request;
  const method = typeof r?.method === 'string' ? r.method.toUpperCase() : '';
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
    throw new FhirServerError(
      400,
      `Entry ${index}: request.method "${r?.method}" is not one`,
      'required',
    );
  if (typeof r.url !== 'string' || !r.url || /^[a-z][a-z0-9+.-]*:/i.test(r.url))
    throw new FhirServerError(
      400,
      `Entry ${index}: request.url must be relative to the server base`,
      'required',
    );
  return method;
}

/** The objects of a resource that hold a reference: { reference: '...' } */
function referencesOf(value: unknown, out: Record<string, any>[] = []) {
  if (Array.isArray(value)) for (const v of value) referencesOf(v, out);
  else if (value && typeof value === 'object') {
    const o = value as Record<string, any>;
    if (typeof o.reference === 'string') out.push(o);
    for (const v of Object.values(o)) referencesOf(v, out);
  }
  return out;
}

/** The error a failed transaction entry ends the transaction with, naming the entry */
async function entryFailure(
  response: Response,
  index: number,
): Promise<FhirServerError> {
  const text = await response.text();
  let issues: FhirOutcomeIssue[] = [];
  try {
    issues = parseFhirJson(text)?.issue ?? [];
  } catch {
    /* not an OperationOutcome */
  }
  const named = issues.map(i => ({
    ...i,
    diagnostics: i.diagnostics?.startsWith('Entry ')
      ? i.diagnostics
      : `Entry ${index}: ${i.diagnostics ?? response.statusText}`,
  }));
  const e = new FhirServerError(
    response.status,
    named[0]?.diagnostics ?? `Entry ${index} failed`,
    'processing',
    named,
  );
  const challenge = response.headers.get('WWW-Authenticate');
  if (challenge) e.headers = { 'WWW-Authenticate': challenge };
  return e;
}

/**
 * The search parameters of a type the server parses and the store answers:
 * those the store names, or every one with an expression when it names none
 */
function searchParams(
  model: FhirContext['model'],
  type: string,
  caps: StoreCapabilities,
): Pick<Served, 'params' | 'components'> {
  const params = new Map<string, FhirSearchParameter>();
  const components = new Map<string, SearchComponent[]>();
  if (!caps.interactions.includes('search')) return { params, components };
  const all = model.searchParameters(type);
  for (const code of caps.searchParams ?? [])
    if (!all.has(code))
      throw new TypeError(
        `The store of ${type} names a search parameter ${type} does not have: ${code}`,
      );
  const byUrl = new Map([...all.values()].map(p => [p.url, p]));
  for (const [code, p] of all) {
    if (!SEARCH_TYPES.has(p.type)) continue;
    if (!(caps.searchParams ? caps.searchParams.includes(code) : p.expression))
      continue;
    if (p.type === 'composite') {
      // its parts, each a parameter of a type the server parses
      const parts = (p.component ?? []).map(c => {
        const param = byUrl.get(c.definition);
        return param &&
          param.type !== 'composite' &&
          SEARCH_TYPES.has(param.type)
          ? { param, expression: c.expression }
          : undefined;
      });
      if (!parts.length || parts.some(c => !c)) {
        if (caps.searchParams)
          throw new TypeError(
            `The store of ${type} names a composite parameter whose components are not known: ${code}`,
          );
        continue;
      }
      components.set(code, parts as SearchComponent[]);
    }
    params.set(code, p);
  }
  return { params, components };
}

/** The store, when it declares the interaction and has its method; 405 otherwise */
function need(
  served: Served,
  interaction: FhirStoreInteraction,
  what: string,
): FhirStore {
  const m = METHOD[interaction];
  if (
    !m ||
    !served.caps.interactions.includes(interaction) ||
    typeof served.store[m] !== 'function'
  )
    throw new FhirServerError(
      405,
      `${interaction} is not supported for ${what}`,
      'not-supported',
    );
  return served.store;
}

function notAllowed(method: string, what: string): FhirServerError {
  return new FhirServerError(
    405,
    `${method} is not supported on ${what}`,
    'not-supported',
  );
}

/** ETag and Last-Modified of a stored version */
function versionHeaders(
  s: StoredResource,
  served: Served,
): Record<string, string> {
  const h: Record<string, string> = {};
  if (s.versionId !== undefined && served.caps.versions !== 'none')
    h.ETag = `W/"${s.versionId}"`;
  if (s.lastUpdated) {
    const t = Date.parse(s.lastUpdated);
    if (!Number.isNaN(t)) h['Last-Modified'] = new Date(t).toUTCString();
  }
  return h;
}

/** The version of If-Match: W/"3" or "3"; refused by a store without versions */
function ifMatchOf(request: Request, served: Served): string | undefined {
  const h = request.headers.get('If-Match');
  if (h === null) return;
  if (served.caps.versions === 'none')
    throw new FhirServerError(
      412,
      'If-Match: this server keeps no versions of the resource',
      'not-supported',
    );
  const m = /^\s*(?:W\/)?"([^"]*)"\s*$/.exec(h);
  if (!m || !ID.test(m[1]))
    throw new FhirServerError(
      400,
      `If-Match: "${h}" is not a version (W/"3")`,
      'value',
    );
  return m[1];
}

/** Prefer: return=minimal | representation | OperationOutcome */
function preferReturn(request: Request): string | undefined {
  const h = request.headers.get('Prefer');
  return h ? /(?:^|[;,\s])return=([A-Za-z]+)/.exec(h)?.[1] : undefined;
}

function intParam(q: URLSearchParams, name: string): number | undefined {
  const v = q.get(name);
  if (v === null) return;
  if (!/^\d+$/.test(v))
    throw new FhirServerError(400, `${name}: "${v}" is not a number`, 'value');
  return Number(v);
}

function mediaTypeOf(header: string | null): string {
  return (header ?? '').split(';')[0].trim().toLowerCase();
}

/** JSON only: _format, or Accept when _format is not given; 406 otherwise */
function checkFormat(request: Request, url: URL) {
  const format = url.searchParams.get('_format');
  if (format !== null) {
    if (!JSON_FORMATS.has(format.trim().toLowerCase()))
      throw new FhirServerError(
        406,
        `_format=${format}: this server answers JSON only`,
        'not-supported',
      );
    return;
  }
  const accept = request.headers.get('Accept');
  if (!accept) return;
  const types = accept.split(',').map(mediaTypeOf);
  if (
    !types.some(t => t === '*/*' || t === 'application/*' || JSON_TYPES.has(t))
  )
    throw new FhirServerError(
      406,
      `Accept: ${accept}: this server answers JSON only`,
      'not-supported',
    );
}

function jsonResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': `${FHIR_JSON}; charset=utf-8`, ...headers },
  });
}

function outcomeResponse(e: FhirServerError): Response {
  return jsonResponse(e.status, JSON.stringify(e.outcome()), e.headers);
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  409: 'Conflict',
  410: 'Gone',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

/**
 * A reference value that is an absolute URL of this server is given to the
 * store as its type and id, without the URL: a store need not know the base
 * to find its own references. URLs of other servers keep their `url`.
 */
function localReferences(c: SearchCriterion, baseUrl: string): void {
  const local = (v: SearchValue) => {
    if (v.url?.startsWith(baseUrl + '/') && v.type && v.id) delete v.url;
    v.components?.forEach(local);
  };
  c.values.forEach(local);
  c.chain?.criteria.forEach(k => localReferences(k, baseUrl));
  c.has?.criteria.forEach(k => localReferences(k, baseUrl));
}

/** The response entry of a batch or transaction: status, headers, and the resource or the outcome */
async function entryOf(response: Response): Promise<Record<string, any>> {
  const r: Record<string, any> = {
    status: `${response.status} ${STATUS_TEXT[response.status] ?? ''}`.trim(),
  };
  const location = response.headers.get('Location');
  if (location) r.location = location;
  const etag = response.headers.get('ETag');
  if (etag) r.etag = etag;
  const text = await response.text();
  const json = text ? parseFhirJson(text) : undefined;
  // the resource's own time, to the millisecond; the header's is to the second
  const modified = response.headers.get('Last-Modified');
  const updated = json?.meta?.lastUpdated;
  if (typeof updated === 'string' && response.status < 400)
    r.lastModified = updated;
  else if (modified) r.lastModified = new Date(modified).toISOString();
  const entry: Record<string, any> = {};
  if (json && response.status >= 400) r.outcome = json;
  else if (json) entry.resource = json;
  entry.response = r;
  return entry;
}

/** JSON text of a parsed FHIR JSON value, its decimals as they were written */
function stringifyJson(value: unknown): string {
  return JSON.stringify(value, function (this: any, key, v) {
    return typeof v === 'number' ? rawDecimal(v, getDecimalText(this, key)) : v;
  });
}
