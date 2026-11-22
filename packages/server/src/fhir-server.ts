import {
  type FhirContext,
  type FhirSearchParameter,
  parseFhirJson,
} from '@fhirjs/core';
import { FhirServerError } from './fhir-server-error.js';
import type {
  FhirStore,
  FhirStoreInteraction,
  StoreCapabilities,
  StoredResource,
  StoredVersion,
} from './fhir-store.js';
import { SearchMatcher } from './search-match.js';
import {
  parseCriterion,
  RESULT_PARAMS,
  SEARCH_TYPES,
  type SearchCriterion,
  type SearchQuery,
} from './search-query.js';

/** A step around each exchange: (request, next) => response, as in the client */
export type FhirServerInterceptor = (
  request: Request,
  next: (request: Request) => Promise<Response>,
) => Promise<Response>;

export interface FhirServerOptions {
  /** The FHIR version's model (and profiles, packages) resources are checked with */
  fhir: FhirContext;
  /** The store of the types that have none of their own in `stores` */
  store?: FhirStore;
  /** Stores of their own, by resource type: a facade over an existing database */
  stores?: Record<string, FhirStore>;
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
  /** The software name in the CapabilityStatement */
  name?: string;
  /** Called with an error the server did not expect; the client gets a 500 */
  onError?: (error: unknown, request: Request) => void;
}

/** A type the server serves, with its store and what the store declared */
interface Served {
  store: FhirStore;
  caps: StoreCapabilities;
  /** The search parameters the store answers and the server parses, by code */
  params: Map<string, FhirSearchParameter>;
}

const FHIR_JSON = 'application/fhir+json';
const JSON_TYPES = new Set([
  FHIR_JSON,
  'application/json',
  'application/json+fhir',
]);
const JSON_FORMATS = new Set(['json', ...JSON_TYPES]);
/** A FHIR id, and a version id */
const ID = /^[A-Za-z0-9\-.]{1,64}$/;

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
 * A FHIR server: answers the REST API of a FHIR version from stores, as a
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
  private readonly _served = new Map<string, Served>();
  private readonly _handle: (request: Request) => Promise<Response>;
  private readonly _date = new Date().toISOString();
  private readonly _matcher: SearchMatcher;

  constructor(readonly options: FhirServerOptions) {
    this.fhir = options.fhir;
    this._matcher = new SearchMatcher(this.fhir);
    this.base = (options.base ?? '').replace(/\/+$/, '');
    if (this.base && !this.base.startsWith('/'))
      throw new TypeError(`base must be a path: "${options.base}"`);
    const model = this.fhir.model;
    const types = options.resources ?? model.resourceTypes();
    for (const type of types) {
      if (!model.resourceTypes().includes(type))
        throw new TypeError(
          `${type} is not a resource type of FHIR ${model.fhirVersion}`,
        );
      const store = options.stores?.[type] ?? options.store;
      const caps = store?.capabilities(type);
      if (caps && store)
        this._served.set(type, {
          store,
          caps,
          params: searchParams(model, type, caps),
        });
      else if (options.resources)
        throw new TypeError(`No store serves ${type}`);
    }
    for (const type of Object.keys(options.stores ?? {}))
      if (!this._served.has(type))
        throw new TypeError(
          `The store of ${type} does not serve it, or ${type} is not in resources`,
        );
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
    checkFormat(request, url);
    const seg = path
      .split('/')
      .filter(Boolean)
      .map(s => decodeURIComponent(s));
    const method = request.method.toUpperCase();
    const ctx: Exchange = {
      request,
      url,
      method,
      baseUrl: url.origin + this.base,
    };

    if (!seg.length) throw notAllowed(method, 'the server base');
    if (seg[0] === 'metadata' && seg.length === 1) {
      if (method !== 'GET') throw notAllowed(method, 'metadata');
      return jsonResponse(
        200,
        JSON.stringify(this.capabilityStatement(ctx.baseUrl)),
      );
    }
    if (seg[0] === '_history' && seg.length === 1) {
      if (method !== 'GET') throw notAllowed(method, '_history');
      return this._history(ctx, this._systemStore(), undefined, undefined);
    }
    if (seg[0].startsWith('$') || seg.some(s => s.startsWith('$')))
      throw new FhirServerError(
        404,
        `Unknown operation ${seg.find(s => s.startsWith('$'))}`,
        'not-supported',
      );

    const type = seg[0];
    const served = this._served.get(type);
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
        if (method === 'GET') return this._read(type, id, served);
        if (method === 'PUT') return this._update(ctx, type, id, served);
        if (method === 'DELETE') return this._delete(ctx, type, id, served);
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
        return this._vread(type, id, vid, served);
    }
    throw new FhirServerError(
      404,
      `${path} is not a FHIR interaction`,
      'not-found',
    );
  }

  /* ---------------------------------------------------------------- */
  /* Interactions                                                     */
  /* ---------------------------------------------------------------- */

  private async _read(
    type: string,
    id: string,
    served: Served,
  ): Promise<Response> {
    const s = await need(served, 'read', type).read!(type, id);
    return this._found(s, `${type}/${id}`, served);
  }

  private async _vread(
    type: string,
    id: string,
    vid: string,
    served: Served,
  ): Promise<Response> {
    const s = await need(served, 'vread', type).vread!(type, id, vid);
    return this._found(s, `${type}/${id}/_history/${vid}`, served);
  }

  private _found(
    s: StoredResource | undefined,
    what: string,
    served: Served,
  ): Response {
    if (!s) throw new FhirServerError(404, `${what} is not known`, 'not-found');
    if (!s.resource)
      throw new FhirServerError(410, `${what} was deleted`, 'deleted');
    return jsonResponse(200, this._text(s), versionHeaders(s, served));
  }

  private async _create(
    ctx: Exchange,
    type: string,
    served: Served,
  ): Promise<Response> {
    const store = need(served, 'create', type);
    const { id: _ignored, ...resource } = await this._body(ctx, type);
    const s = await store.create!(type, resource);
    return this._written(ctx, s, 201, served);
  }

  private async _update(
    ctx: Exchange,
    type: string,
    id: string,
    served: Served,
  ): Promise<Response> {
    const store = need(served, 'update', type);
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
    const s = await store.update!(
      type,
      id,
      resource,
      ifMatchOf(ctx.request, served),
    );
    if (!s)
      throw new FhirServerError(
        405,
        `${type}/${id} does not exist, and the server does not create resources by update`,
        'not-supported',
      );
    return this._written(ctx, s, s.method === 'POST' ? 201 : 200, served);
  }

  private async _delete(
    ctx: Exchange,
    type: string,
    id: string,
    served: Served,
  ): Promise<Response> {
    const store = need(served, 'delete', type);
    await store.delete!(type, id, ifMatchOf(ctx.request, served));
    return new Response(null, { status: 204 });
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
    const page = await store.history!(type, id, { since, count, offset });

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
    const strict = /(?:^|[;,\s])handling=strict\b/.test(
      ctx.request.headers.get('Prefer') ?? '',
    );
    const isResourceType = (name: string) =>
      this.fhir.model.resourceTypes().includes(name);
    const criteria: SearchCriterion[] = [];
    const applied = new URLSearchParams();
    for (const [name, value] of params) {
      if (RESULT_PARAMS.has(name)) continue;
      const colon = name.indexOf(':');
      const code = colon < 0 ? name : name.slice(0, colon);
      const modifier = colon < 0 ? undefined : name.slice(colon + 1);
      const param = served.params.get(code);
      if (!param || code.includes('.')) {
        if (strict)
          throw new FhirServerError(
            400,
            `Unknown search parameter ${name} for ${type}`,
            'not-supported',
          );
        continue;
      }
      criteria.push(parseCriterion(param, modifier, value, isResourceType));
      applied.append(name, value);
    }
    const count = Math.min(
      intParam(params, '_count') ?? this.options.defaultCount ?? 50,
      this.options.maxCount ?? 500,
    );
    const offset = intParam(params, '_offset') ?? 0;
    const baseUrl = ctx.baseUrl;
    const query: SearchQuery = {
      type,
      criteria,
      count,
      offset,
      matches: resource => this._matcher.matches(resource, criteria, baseUrl),
    };
    const page = await store.search!(type, query);

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
    if (page.items.length)
      bundle.entry = page.items.map(s => ({
        fullUrl: `${baseUrl}/${s.type}/${s.id}`,
        resource: this._json(s),
        search: { mode: 'match' },
      }));
    return jsonResponse(200, JSON.stringify(bundle));
  }

  /** The store of system history: the one store of every type served */
  private _systemStore(): Served {
    const stores = new Set([...this._served.values()].map(s => s.store));
    const first = this._served.values().next().value;
    if (stores.size !== 1 || !first)
      throw new FhirServerError(
        405,
        'History of the whole server is not supported: its types are in different stores',
        'not-supported',
      );
    return first;
  }

  /* ---------------------------------------------------------------- */
  /* Bodies                                                           */
  /* ---------------------------------------------------------------- */

  /** The resource of a write, checked against the model; its JSON form */
  private async _body(
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
  /* Capabilities                                                     */
  /* ---------------------------------------------------------------- */

  /** The CapabilityStatement: what each type's store declares */
  capabilityStatement(baseUrl: string): Record<string, any> {
    const resource = [...this._served].map(
      ([type, { store, caps, params }]) => {
        const interactions = caps.interactions.filter(
          i => METHOD[i] && typeof store[METHOD[i]!] === 'function',
        );
        const r: Record<string, any> = {
          type,
          interaction: interactions
            .flatMap(i => CAPABILITY_CODES[i])
            .map(code => ({ code })),
          versioning:
            caps.versions === 'none' ? 'no-version' : 'versioned-update',
          readHistory:
            caps.versions === 'all' && caps.interactions.includes('vread'),
          updateCreate: !!caps.updateCreate,
        };
        if (interactions.includes('search') && params.size)
          r.searchParam = [...params.values()].map(p => ({
            name: p.code,
            definition: p.url,
            type: p.type,
          }));
        return r;
      },
    );
    const rest: Record<string, any> = { mode: 'server', resource };
    try {
      if (this._systemStore().caps.interactions.includes('history'))
        rest.interaction = [{ code: 'history-system' }];
    } catch {
      /* types in different stores: no system history */
    }
    return {
      resourceType: 'CapabilityStatement',
      status: 'active',
      date: this._date,
      kind: 'instance',
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

interface Exchange {
  request: Request;
  url: URL;
  method: string;
  /** The server's base URL: 'http://host/fhir' */
  baseUrl: string;
}

/**
 * The search parameters of a type the server parses and the store answers:
 * those the store names, or every one with an expression when it names none
 */
function searchParams(
  model: FhirContext['model'],
  type: string,
  caps: StoreCapabilities,
): Map<string, FhirSearchParameter> {
  const out = new Map<string, FhirSearchParameter>();
  if (!caps.interactions.includes('search')) return out;
  const all = model.searchParameters(type);
  for (const code of caps.searchParams ?? [])
    if (!all.has(code))
      throw new TypeError(
        `The store of ${type} names a search parameter ${type} does not have: ${code}`,
      );
  for (const [code, p] of all) {
    if (!SEARCH_TYPES.has(p.type)) continue;
    if (caps.searchParams ? caps.searchParams.includes(code) : p.expression)
      out.set(code, p);
  }
  return out;
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
  return jsonResponse(e.status, JSON.stringify(e.outcome()));
}
