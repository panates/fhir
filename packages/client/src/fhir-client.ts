import {
  type FhirCodecOptions,
  type FhirContext,
  parseFhirJson,
  resourceTypeOf,
} from '@fhirjs/core';
import { FhirClientError } from './fhir-client-error.js';
import { type FhirSearchParams, toSearchParams } from './search-params.js';

/** A resource class (Patient) or a resource type name ('Patient') */
export type ResourceTypeArg<T> = string | (abstract new (...args: any[]) => T);

/**
 * A step around each HTTP exchange: change the request (a token), look at
 * or replace the response, retry. Calls `next` to go on.
 */
export type FhirClientInterceptor = (
  request: Request,
  next: (request: Request) => Promise<Response>,
) => Promise<Response>;

export interface FhirClientOptions {
  /** The server's base URL: https://server/fhir */
  baseUrl: string | URL;
  /** The FHIR version's model (and profiles, packages) resources are read and written with */
  fhir: FhirContext;
  /** Headers of every request */
  headers?: Record<string, string>;
  /** Steps around each exchange, the first given outermost */
  interceptors?: FhirClientInterceptor[];
  /** How responses are decoded: unknownElements: 'keep' for a lenient read ... */
  decode?: FhirCodecOptions;
  /** The fetch to use (default: the global one) */
  fetch?: typeof fetch;
}

/** Options of one request */
export interface FhirRequestOptions {
  /** Headers of this request only */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Which part of a resource to ask for (`_summary`, `_elements`). The server
 * leaves the rest out and tags the resource SUBSETTED; such a resource is
 * read without the required elements, and update() refuses it.
 */
export interface FhirReadOptions extends FhirRequestOptions {
  /** _summary: 'true' (the summary elements), 'text', 'data', 'count' */
  summary?: 'true' | 'text' | 'data' | 'count' | 'false';
  /** _elements: these top-level elements (and the mandatory ones) */
  elements?: readonly string[];
}

export interface FhirUpdateOptions extends FhirRequestOptions {
  /**
   * If-Match: update only that version (a version id), or the version in
   * the resource's meta.versionId (true). The server answers 412 otherwise.
   */
  ifMatch?: string | true;
  /**
   * Conditional update: PUT [type]?search. The server updates the one
   * resource the search finds, creates one when it finds none, and fails
   * (412) when it finds more. The resource needs no id then.
   */
  where?: FhirSearchParams;
}

export interface FhirCreateOptions extends FhirRequestOptions {
  /** If-None-Exist: create only when this search finds nothing (conditional create) */
  ifNoneExist?: FhirSearchParams;
}

export interface FhirSearchOptions extends FhirReadOptions {
  /** POST [type]/_search with the parameters in a form body (long queries, no parameters in logs) */
  method?: 'GET' | 'POST';
}

export interface FhirOperationOptions extends FhirRequestOptions {
  /** On a type ('Patient/$match') or an instance ('Patient/1/$everything'); the server when neither */
  type?: ResourceTypeArg<any>;
  id?: string;
  /** The input: a Parameters resource (or another resource the operation takes) */
  input?: object;
  /** GET with these as URL parameters, for an operation without side effects */
  params?: FhirSearchParams;
}

/** A JSON Patch operation (RFC 6902) */
export interface JsonPatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

const FHIR_JSON = 'application/fhir+json';
const SUBSETTED_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/v3-ObservationValue';

/** Whether a resource (or a Bundle entry's) carries the SUBSETTED tag: a part of it was left out */
function isSubsetted(json: any): boolean {
  const tagged = (r: any) =>
    Array.isArray(r?.meta?.tag) &&
    r.meta.tag.some(
      (t: any) =>
        t?.code === 'SUBSETTED' &&
        (t.system === undefined || t.system === SUBSETTED_SYSTEM),
    );
  if (tagged(json)) return true;
  return (
    Array.isArray(json?.entry) &&
    json.entry.some((e: any) => tagged(e?.resource))
  );
}

/** _summary and _elements as search parameters */
function partialParams(options: FhirReadOptions | undefined): URLSearchParams {
  const q = new URLSearchParams();
  if (options?.summary) q.set('_summary', options.summary);
  if (options?.elements?.length) q.set('_elements', options.elements.join(','));
  return q;
}

const withQuery = (path: string, q: URLSearchParams) =>
  q.size ? `${path}?${q}` : path;
/** A FHIR id: a path segment can carry nothing else (no '/', no '..') */
const ID = /^[A-Za-z0-9\-.]{1,64}$/;

/**
 * A client of a FHIR server's REST API. Resources go and come as instances
 * of the model's classes, checked by its codec; the version is the
 * context's.
 *
 * ```ts
 * const client = new FhirClient({ baseUrl: 'https://server/fhir', fhir: new FhirContext(r4Model) });
 * const patient = await client.read(Patient, '123');
 * const found = await client.search(Observation, { subject: 'Patient/123', _count: 50 });
 * for await (const page of found.pages()) ...
 * ```
 */
export class FhirClient {
  readonly baseUrl: string;
  readonly fhir: FhirContext;
  private readonly _fetch: typeof fetch;

  constructor(readonly options: FhirClientOptions) {
    this.baseUrl = String(options.baseUrl).replace(/\/+$/, '');
    this.fhir = options.fhir;
    this._fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /* ---------------------------------------------------------------- */
  /* Instance level                                                   */
  /* ---------------------------------------------------------------- */

  /** GET [type]/[id]: the current version of a resource (or a part of it: `summary`, `elements`) */
  async read<T = any>(
    type: ResourceTypeArg<T>,
    id: string,
    options?: FhirReadOptions,
  ): Promise<T> {
    const name = this._typeName(type);
    const r = await this.request(
      'GET',
      withQuery(`${name}/${this._id(id)}`, partialParams(options)),
      options,
    );
    return this._resource(r, type);
  }

  /** GET [type]/[id]/_history/[vid]: a version of a resource */
  async vread<T = any>(
    type: ResourceTypeArg<T>,
    id: string,
    versionId: string,
    options?: FhirReadOptions,
  ): Promise<T> {
    const name = this._typeName(type);
    const r = await this.request(
      'GET',
      withQuery(
        `${name}/${this._id(id)}/_history/${this._id(versionId)}`,
        partialParams(options),
      ),
      options,
    );
    return this._resource(r, type);
  }

  /**
   * POST [type]: creates a resource; gives it back as the server stored it
   * (with its id and meta). When the server answers without a body, the
   * resource is read from the Location it gives.
   */
  async create<T extends object>(
    resource: T,
    options: FhirCreateOptions = {},
  ): Promise<T> {
    const name = this._resourceTypeOf(resource);
    const headers: Record<string, string> = {
      Prefer: 'return=representation',
      ...options.headers,
    };
    if (options.ifNoneExist)
      headers['If-None-Exist'] = toSearchParams(options.ifNoneExist).toString();
    const r = await this.request('POST', name, {
      ...options,
      headers,
      body: resource,
    });
    return this._stored(
      r,
      resource.constructor as ResourceTypeArg<T>,
      name,
      options,
    );
  }

  /**
   * PUT [type]/[id]: replaces a resource (its id is the resource's own), or
   * PUT [type]?search with `where`; gives it back as stored. A resource read
   * in part (SUBSETTED) is refused: it would erase what was left out.
   */
  async update<T extends object>(
    resource: T,
    options: FhirUpdateOptions = {},
  ): Promise<T> {
    const name = this._resourceTypeOf(resource);
    if (isSubsetted(resource))
      throw new TypeError(
        `update(): the ${name} was read in part (SUBSETTED); read it whole to update it`,
      );
    const id = (resource as any).id;
    let path: string;
    if (options.where) path = this._conditional(name, options.where, 'update');
    else if (typeof id === 'string') path = `${name}/${this._id(id)}`;
    else throw new TypeError(`update(): the ${name} has no id`);
    const headers: Record<string, string> = {
      Prefer: 'return=representation',
      ...options.headers,
    };
    if (options.ifMatch) {
      const v =
        options.ifMatch === true
          ? (resource as any).meta?.versionId
          : options.ifMatch;
      if (typeof v !== 'string')
        throw new TypeError(
          `update(): ifMatch: the ${name} has no meta.versionId`,
        );
      headers['If-Match'] = `W/"${v}"`;
    }
    const r = await this.request('PUT', path, {
      ...options,
      headers,
      body: resource,
    });
    return this._stored(
      r,
      resource.constructor as ResourceTypeArg<T>,
      name,
      options,
    );
  }

  /**
   * PATCH [type]/[id] (or [type]?search: the one resource it finds) with a
   * JSON Patch; gives the resource back as stored
   */
  async patch<T = any>(
    type: ResourceTypeArg<T>,
    target: string | FhirSearchParams,
    patch: JsonPatchOperation[],
    options: FhirUpdateOptions = {},
  ): Promise<T> {
    const name = this._typeName(type);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json-patch+json',
      Prefer: 'return=representation',
      ...options.headers,
    };
    if (typeof options.ifMatch === 'string')
      headers['If-Match'] = `W/"${options.ifMatch}"`;
    const r = await this.request('PATCH', this._target(name, target, 'patch'), {
      ...options,
      headers,
      body: JSON.stringify(patch),
    });
    return this._stored(r, type, name, options);
  }

  /** DELETE [type]/[id], or [type]?search: what the search finds (conditional delete) */
  async delete(
    type: ResourceTypeArg<any>,
    target: string | FhirSearchParams,
    options?: FhirRequestOptions,
  ): Promise<void> {
    const name = this._typeName(type);
    const r = await this.request(
      'DELETE',
      this._target(name, target, 'delete'),
      options,
    );
    await r.body?.cancel();
  }

  /* ---------------------------------------------------------------- */
  /* Type and server level                                            */
  /* ---------------------------------------------------------------- */

  /** GET [type]?params (or POST [type]/_search): a page of matches, with the way to the next */
  async search<T = any>(
    type: ResourceTypeArg<T>,
    params?: FhirSearchParams,
    options: FhirSearchOptions = {},
  ): Promise<FhirSearchResult<T>> {
    const name = this._typeName(type);
    const query = toSearchParams(params);
    for (const [k, v] of partialParams(options)) query.set(k, v);
    const r =
      options.method === 'POST'
        ? await this.request('POST', `${name}/_search`, {
            ...options,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              ...options.headers,
            },
            body: query.toString(),
          })
        : await this.request(
            'GET',
            name + (query.size ? '?' + query : ''),
            options,
          );
    return new FhirSearchResult<T>(this, await this._decode(r), options);
  }

  /** GET [type]/[id]/_history, [type]/_history or _history: versions, as a search result */
  async history<T = any>(
    type?: ResourceTypeArg<T>,
    id?: string,
    params?: FhirSearchParams,
    options: FhirRequestOptions = {},
  ): Promise<FhirSearchResult<T>> {
    let path = '_history';
    if (type)
      path = `${this._typeName(type)}/${id === undefined ? '' : this._id(id) + '/'}_history`;
    const query = toSearchParams(params);
    const r = await this.request(
      'GET',
      path + (query.size ? '?' + query : ''),
      options,
    );
    return new FhirSearchResult<T>(this, await this._decode(r), options);
  }

  /** GET metadata: the server's CapabilityStatement */
  async capabilities<T = any>(options?: FhirRequestOptions): Promise<T> {
    return this._resource(
      await this.request('GET', 'metadata', options),
      'CapabilityStatement',
    );
  }

  /**
   * An operation: POST [type/[id]/]$name with `input` (or GET with `params`).
   * Gives the resource it answers with (Parameters, a Bundle ...), or
   * undefined when it answers without a body.
   */
  async operation<T = any>(
    name: string,
    options: FhirOperationOptions = {},
  ): Promise<T | undefined> {
    const op = name.startsWith('$') ? name : '$' + name;
    if (!/^\$[A-Za-z][\w-]*$/.test(op))
      throw new TypeError(`operation(): "${name}" is not an operation name`);
    let path = op;
    if (options.type)
      path = `${this._typeName(options.type)}/${options.id === undefined ? '' : this._id(options.id) + '/'}${op}`;
    else if (options.id !== undefined)
      throw new TypeError('operation(): an id needs a type');
    const r = options.params
      ? await this.request(
          'GET',
          `${path}?${toSearchParams(options.params)}`,
          options,
        )
      : await this.request('POST', path, { ...options, body: options.input });
    return this._decodeOptional(r);
  }

  /** POST [base] with a transaction Bundle: all or nothing. Gives the response Bundle. */
  async transaction<T = any>(
    bundle: object,
    options?: FhirRequestOptions,
  ): Promise<T> {
    return this._bundle(bundle, 'transaction', options);
  }

  /** POST [base] with a batch Bundle: each entry on its own. Gives the response Bundle. */
  async batch<T = any>(
    bundle: object,
    options?: FhirRequestOptions,
  ): Promise<T> {
    return this._bundle(bundle, 'batch', options);
  }

  /* ---------------------------------------------------------------- */
  /* HTTP                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * One HTTP exchange with the server, through the interceptors: `path` is
   * relative to the base URL, or an absolute URL on the same server (a
   * Bundle's next link). A resource body is written with the context's codec.
   * Throws FhirClientError for a status other than 2xx.
   */
  async request(
    method: string,
    path: string,
    options: FhirRequestOptions & { body?: object | string } = {},
  ): Promise<Response> {
    const url = this._url(path);
    const headers = new Headers({
      Accept: FHIR_JSON,
      ...this.options.headers,
      ...options.headers,
    });
    let body: string | undefined;
    if (options.body !== undefined) {
      body =
        typeof options.body === 'string'
          ? options.body
          : this.fhir.stringify(options.body);
      if (!headers.has('Content-Type'))
        headers.set('Content-Type', `${FHIR_JSON}; charset=utf-8`);
    }
    const request = new Request(url, {
      method,
      headers,
      body,
      signal: options.signal,
    });
    const chain = (this.options.interceptors ?? []).reduceRight<
      (r: Request) => Promise<Response>
    >(
      (next, interceptor) => r => interceptor(r, next),
      r => this._fetch(r),
    );
    const response = await chain(request);
    if (!response.ok) throw await this._error(response, method, url);
    return response;
  }

  /** A URL on this server: a path under the base, or an absolute URL under it */
  private _url(path: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
      // a link the server gave (next page): only under the base URL, so
      // headers (a token) go nowhere else
      if (!(
        path === this.baseUrl ||
        path.startsWith(this.baseUrl + '/') ||
        path.startsWith(this.baseUrl + '?')
      ))
        throw new FhirClientError(
          `${path} is not on the server ${this.baseUrl}`,
          0,
        );
      return path;
    }
    return `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
  }

  private async _error(
    response: Response,
    method: string,
    url: string,
  ): Promise<FhirClientError> {
    let outcome: Record<string, any> | undefined;
    const text = await response.text().catch(() => '');
    try {
      const json = text ? JSON.parse(text) : undefined;
      if (json?.resourceType === 'OperationOutcome') outcome = json;
    } catch {
      /* not JSON: an HTML error page, a proxy's text */
    }
    const issues: any[] = Array.isArray(outcome?.issue) ? outcome!.issue : [];
    const detail = issues
      .map(i => i?.diagnostics ?? i?.details?.text)
      .filter(Boolean)
      .join('; ');
    return new FhirClientError(
      `${method} ${url}: ${response.status} ${response.statusText}${detail ? ` (${detail})` : ''}`,
      response.status,
      outcome,
      { method, url },
    );
  }

  /* ---------------------------------------------------------------- */
  /* Bodies                                                           */
  /* ---------------------------------------------------------------- */

  /** The response's resource, decoded; undefined for an empty body */
  private async _decodeOptional(
    r: Response,
    type?: ResourceTypeArg<any>,
  ): Promise<any> {
    const text = await r.text();
    if (!text.trim()) return undefined;
    return this.decodeJson(parseFhirJson(text), type);
  }

  /**
   * A resource the server sent, decoded with the client's options; one read
   * in part (SUBSETTED, or a Bundle with such entries) without its required
   * elements
   */
  decodeJson<T = any>(json: unknown, type?: ResourceTypeArg<T>): T {
    const partial = isSubsetted(json) || undefined;
    return this.fhir.decode(
      json as object,
      type,
      partial ? { ...this.options.decode, partial } : this.options.decode,
    );
  }

  private async _decode(
    r: Response,
    type?: ResourceTypeArg<any>,
  ): Promise<any> {
    const value = await this._decodeOptional(r, type);
    if (value === undefined)
      throw new FhirClientError(
        `${r.url}: an empty response, a resource expected`,
        r.status,
      );
    return value;
  }

  /** The resource of a response, checked to be of the type asked for */
  private async _resource<T>(
    r: Response,
    type: ResourceTypeArg<T>,
  ): Promise<T> {
    const json = parseFhirJson(await r.text());
    const want = this._typeName(type);
    if (json?.resourceType !== want)
      throw new FhirClientError(
        `${r.url}: a ${want} expected, the server sent ${json?.resourceType ?? 'no resource'}`,
        r.status,
      );
    return this.decodeJson(json, type);
  }

  /** What create/update/patch answer: the stored resource, from the body or the Location */
  private async _stored<T>(
    r: Response,
    type: ResourceTypeArg<T>,
    name: string,
    options: FhirRequestOptions,
  ): Promise<T> {
    const text = await r.text();
    if (text.trim()) {
      const json = parseFhirJson(text);
      if (json?.resourceType === name)
        return this.decodeJson(json, typeof type === 'function' ? type : name);
    }
    // no representation (or an OperationOutcome): read what the Location names
    const location =
      r.headers.get('Content-Location') ?? r.headers.get('Location');
    const m =
      location &&
      /([A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/([A-Za-z0-9\-.]{1,64}))?\/?$/.exec(
        location,
      );
    if (!m || m[1] !== name)
      throw new FhirClientError(
        `${r.url}: the server gave neither the ${name} nor its Location`,
        r.status,
      );
    const t = typeof type === 'function' ? type : name;
    return m[3]
      ? this.vread(t, m[2], m[3], options)
      : this.read(t, m[2], options);
  }

  private async _bundle(
    bundle: object,
    kind: 'transaction' | 'batch',
    options?: FhirRequestOptions,
  ) {
    const t = (bundle as any).type;
    if (t !== kind)
      throw new TypeError(
        `${kind}(): the Bundle's type is ${t ?? 'not set'}, not ${kind}`,
      );
    const r = await this.request('POST', '', { ...options, body: bundle });
    return this._decode(r, 'Bundle');
  }

  /* ---------------------------------------------------------------- */
  /* Names                                                            */
  /* ---------------------------------------------------------------- */

  private _typeName(type: ResourceTypeArg<any>): string {
    const name = typeof type === 'string' ? type : resourceTypeOf(type);
    if (!name || !/^[A-Z][A-Za-z]+$/.test(name))
      throw new TypeError(
        `${String((type as any)?.name ?? type)} is not a resource type`,
      );
    return name;
  }

  private _resourceTypeOf(resource: object): string {
    const ctor = resource.constructor;
    const name =
      ctor && ctor !== Object
        ? resourceTypeOf(ctor)
        : (resource as any).resourceType;
    if (typeof name !== 'string')
      throw new TypeError(
        'Not a resource: no resourceType, not an instance of a resource class',
      );
    return this._typeName(name);
  }

  /** [type]/[id], or [type]?search for a conditional interaction */
  private _target(
    name: string,
    target: string | FhirSearchParams,
    what: string,
  ): string {
    return typeof target === 'string'
      ? `${name}/${this._id(target)}`
      : this._conditional(name, target, what);
  }

  /** [type]?search; an empty search would match every resource of the type: refused */
  private _conditional(
    name: string,
    where: FhirSearchParams,
    what: string,
  ): string {
    const q = toSearchParams(where);
    if (!q.size)
      throw new TypeError(
        `${what}(): a conditional ${what} needs search parameters`,
      );
    return `${name}?${q}`;
  }

  private _id(id: string): string {
    if (!ID.test(id)) throw new TypeError(`"${id}" is not a FHIR id`);
    return id;
  }
}

/** A page of a search (or history): its resources, and the way to the others */
export class FhirSearchResult<T = any> {
  constructor(
    private readonly client: FhirClient,
    /** The Bundle of this page */
    readonly bundle: any,
    private readonly options: FhirRequestOptions = {},
  ) {}

  private _entries(mode: 'match' | 'include'): any[] {
    const entries: any[] = Array.isArray(this.bundle?.entry)
      ? this.bundle.entry
      : [];
    return entries
      .filter(
        e =>
          e?.resource &&
          (mode === 'include'
            ? e.search?.mode === 'include'
            : e.search?.mode !== 'include' && e.search?.mode !== 'outcome'),
      )
      .map(e => e.resource);
  }

  /** The resources the search found (not those _include brought) */
  get resources(): T[] {
    return this._entries('match');
  }

  /** Resources _include and _revinclude brought */
  get included(): any[] {
    return this._entries('include');
  }

  /** The number of matches in all pages, when the server counts them */
  get total(): number | undefined {
    return typeof this.bundle?.total === 'number'
      ? this.bundle.total
      : undefined;
  }

  /** The URL of the next page; undefined on the last */
  get nextUrl(): string | undefined {
    const links: any[] = Array.isArray(this.bundle?.link)
      ? this.bundle.link
      : [];
    const url = links.find(l => l?.relation === 'next')?.url;
    return typeof url === 'string' ? url : undefined;
  }

  /** The next page; undefined on the last */
  async next(): Promise<FhirSearchResult<T> | undefined> {
    const url = this.nextUrl;
    if (!url) return;
    const r = await this.client.request('GET', url, this.options);
    return new FhirSearchResult<T>(
      this.client,
      this.client.decodeJson(parseFhirJson(await r.text()), 'Bundle'),
      this.options,
    );
  }

  /** This page and the ones after it, one at a time */
  async *pages(): AsyncGenerator<FhirSearchResult<T>> {
    for (let p: FhirSearchResult<T> | undefined = this; p; p = await p.next())
      yield p;
  }

  /** The resources of this page and the ones after it; stops after `limit` */
  async all(limit = Infinity): Promise<T[]> {
    const out: T[] = [];
    for await (const page of this.pages()) {
      for (const r of page.resources) {
        if (out.length >= limit) return out;
        out.push(r);
      }
    }
    return out;
  }
}
