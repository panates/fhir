/*
 * A small in-memory FHIR server for the client's tests: read, vread,
 * create, update (If-Match), patch (replace/add), delete, search by _id or
 * name with paging, history, an operation, transaction, metadata. It keeps
 * what it is sent as JSON, versions from 1, and answers errors with an
 * OperationOutcome. Every request is recorded.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const outcome = (code: string, diagnostics: string) => ({
  resourceType: 'OperationOutcome',
  issue: [{ severity: 'error', code, diagnostics }],
});

export class TestFhirServer {
  readonly requests: RecordedRequest[] = [];
  /** type/id -> versions (JSON), the last current; null: deleted */
  readonly store = new Map<string, (Record<string, any> | null)[]>();
  /** Answer create and update without a body (Prefer: return=minimal servers) */
  minimal = false;
  /** When set, every request needs Authorization: Bearer <token>; 401 otherwise */
  token?: string;
  private server?: http.Server;
  private nextId = 1;
  baseUrl = '';

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        this.requests.push({
          method: req.method!,
          url: req.url!,
          headers: req.headers,
          body,
        });
        try {
          this.handle(req, body, res);
        } catch (e) {
          this.send(res, 500, outcome('exception', String(e)));
        }
      });
    });
    await new Promise<void>(resolve =>
      this.server!.listen(0, '127.0.0.1', resolve),
    );
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}/fhir`;
    return this.baseUrl;
  }

  /** Empties the store and the request log; ids start at 1 again */
  reset() {
    this.requests.length = 0;
    this.store.clear();
    this.minimal = false;
    this.token = undefined;
    this.nextId = 1;
  }

  async stop() {
    await new Promise<void>(resolve => this.server?.close(() => resolve()));
  }

  /** Puts a resource in the store as version 1 (or the next) */
  put(resource: Record<string, any>): Record<string, any> {
    const key = `${resource.resourceType}/${resource.id}`;
    const versions = this.store.get(key) ?? [];
    const stored = {
      ...resource,
      meta: {
        ...resource.meta,
        versionId: String(versions.length + 1),
        lastUpdated: '2026-11-20T10:00:00Z',
      },
    };
    versions.push(stored);
    this.store.set(key, versions);
    return stored;
  }

  private current(type: string, id: string) {
    return this.store.get(`${type}/${id}`)?.at(-1) ?? undefined;
  }

  private send(
    res: http.ServerResponse,
    status: number,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    res.writeHead(status, {
      ...(body ? { 'Content-Type': 'application/fhir+json' } : {}),
      ...headers,
    });
    res.end(body ? JSON.stringify(body) : undefined);
  }

  private bundle(
    type: string,
    resources: Record<string, any>[],
    total?: number,
    links: { relation: string; url: string }[] = [],
    include: Record<string, any>[] = [],
  ) {
    return {
      resourceType: 'Bundle',
      type,
      ...(total !== undefined ? { total } : {}),
      ...(links.length ? { link: links } : {}),
      entry: [
        ...resources.map(r => ({
          fullUrl: `${this.baseUrl}/${r.resourceType}/${r.id}`,
          resource: r,
          search: { mode: 'match' },
        })),
        ...include.map(r => ({
          fullUrl: `${this.baseUrl}/${r.resourceType}/${r.id}`,
          resource: r,
          search: { mode: 'include' },
        })),
      ],
    };
  }

  /** The current resources of a type a search finds (_id, identifier, name) */
  private find(type: string, params: URLSearchParams): Record<string, any>[] {
    let all = [...this.store.entries()]
      .filter(([k, v]) => k.startsWith(type + '/') && v.at(-1))
      .map(([, v]) => v.at(-1)!);
    if (params.has('_id'))
      all = all.filter(r => params.get('_id')!.split(',').includes(r.id));
    if (params.has('identifier'))
      all = all.filter(r =>
        (r.identifier ?? []).some(
          (i: any) => i.value === params.get('identifier'),
        ),
      );
    for (const name of params.getAll('name'))
      all = all.filter(r =>
        JSON.stringify(r.name ?? [])
          .toLowerCase()
          .includes(name.toLowerCase()),
      );
    return all;
  }

  /** _elements and _summary=true: a part of the resource, tagged SUBSETTED */
  private subset(
    r: Record<string, any>,
    params: URLSearchParams,
  ): Record<string, any> {
    const elements = params.get('_elements')?.split(',');
    const summary = params.get('_summary') === 'true';
    if (!elements && !summary) return r;
    const keep = new Set([
      'resourceType',
      'id',
      'meta',
      ...(elements ?? ['name', 'identifier', 'active']),
    ]);
    const out = Object.fromEntries(
      Object.entries(r).filter(([k]) => keep.has(k)),
    );
    out.meta = {
      ...r.meta,
      tag: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationValue',
          code: 'SUBSETTED',
        },
      ],
    };
    return out;
  }

  private handle(
    req: http.IncomingMessage,
    body: string,
    res: http.ServerResponse,
  ) {
    const url = new URL(req.url!, this.baseUrl);
    const path = url.pathname.replace(/^\/fhir\/?/, '');
    const parts = path ? path.split('/') : [];
    const method = req.method!;
    if (this.token && req.headers.authorization !== `Bearer ${this.token}`)
      return this.send(res, 401, outcome('login', 'a valid token is needed'));
    const json = () => JSON.parse(body);

    if (method === 'GET' && path === 'metadata')
      return this.send(res, 200, {
        resourceType: 'CapabilityStatement',
        status: 'active',
        date: '2026-11-20',
        kind: 'instance',
        fhirVersion: '4.0.1',
        format: ['json'],
      });

    // transaction / batch
    if (method === 'POST' && parts.length === 0) {
      const b = json();
      const entries = (b.entry ?? []).map((e: any) => {
        const stored = this.put({
          ...e.resource,
          id: e.resource.id ?? String(this.nextId++),
        });
        return {
          response: {
            status: '201 Created',
            location: `${stored.resourceType}/${stored.id}/_history/1`,
          },
          resource: stored,
        };
      });
      return this.send(res, 200, {
        resourceType: 'Bundle',
        type: `${b.type}-response`,
        entry: entries,
      });
    }

    // operations
    const op = parts.findIndex(p => p.startsWith('$'));
    if (op >= 0) {
      if (parts[op] === '$everything' && parts.length === 3) {
        const p = this.current(parts[0], parts[1]);
        if (!p)
          return this.send(
            res,
            404,
            outcome('not-found', `${parts[0]}/${parts[1]} is not known`),
          );
        return this.send(res, 200, this.bundle('searchset', [p]));
      }
      if (parts[op] === '$echo')
        return this.send(
          res,
          200,
          method === 'GET'
            ? {
                resourceType: 'Parameters',
                parameter: [...url.searchParams].map(([name, valueString]) => ({
                  name,
                  valueString,
                })),
              }
            : json(),
        );
      if (parts[op] === '$nothing') return this.send(res, 204);
      return this.send(
        res,
        404,
        outcome('not-supported', `${parts[op]} is not supported`),
      );
    }

    const [type, , sub, vid] = parts;
    let id: string | undefined = parts[1];
    if (!/^[A-Z][A-Za-z]+$/.test(type ?? ''))
      return this.send(res, 404, outcome('not-found', `${path} is not known`));

    // conditional update, patch, delete: [type]?search names the resource
    if (
      (method === 'PUT' || method === 'PATCH' || method === 'DELETE') &&
      id === undefined
    ) {
      const found = this.find(type, url.searchParams);
      if (found.length > 1)
        return this.send(
          res,
          412,
          outcome(
            'multiple-matches',
            `${found.length} ${type} resources match`,
          ),
        );
      if (!found.length) {
        if (method === 'DELETE') return this.send(res, 204);
        if (method === 'PATCH')
          return this.send(
            res,
            404,
            outcome('not-found', `no ${type} matches`),
          );
        id = String(this.nextId++);
        const r = JSON.parse(body);
        return this.send(res, 201, this.put({ ...r, id }));
      }
      id = found[0].id as string;
      if (method === 'PUT') body = JSON.stringify({ ...JSON.parse(body), id });
    }

    if (
      (method === 'GET' && (id === undefined || id === '_search')) ||
      (method === 'POST' && id === '_search')
    ) {
      const params =
        method === 'POST' ? new URLSearchParams(body) : url.searchParams;
      const all = this.find(type, params);
      const count = Number(params.get('_count') ?? 50);
      const offset = Number(params.get('_offset') ?? 0);
      const page = all
        .slice(offset, offset + count)
        .map(r => this.subset(r, params));
      const links: { relation: string; url: string }[] = [];
      if (offset + count < all.length) {
        const next = new URLSearchParams(params);
        next.set('_offset', String(offset + count));
        links.push({
          relation: 'next',
          url: `${this.baseUrl}/${type}?${next}`,
        });
      }
      const include =
        params.get('_include') === 'Patient:organization'
          ? page
              .map(p => p.managingOrganization?.reference)
              .filter(Boolean)
              .map((r: string) =>
                this.current(...(r.split('/') as [string, string])),
              )
              .filter(Boolean)
          : [];
      return this.send(
        res,
        200,
        this.bundle('searchset', page, all.length, links, include as any),
      );
    }

    if (method === 'GET' && sub === '_history') {
      const versions = this.store.get(`${type}/${id}`) ?? [];
      if (vid !== undefined) {
        const v = versions[Number(vid) - 1];
        return v
          ? this.send(res, 200, v)
          : this.send(
              res,
              404,
              outcome('not-found', `version ${vid} is not known`),
            );
      }
      return this.send(
        res,
        200,
        this.bundle('history', [...versions].reverse().filter(Boolean) as any),
      );
    }

    if (method === 'GET') {
      const versions = this.store.get(`${type}/${id}`);
      if (versions && versions.at(-1) === null)
        return this.send(
          res,
          410,
          outcome('deleted', `${type}/${id} was deleted`),
        );
      const r = this.current(type, id!);
      return r
        ? this.send(res, 200, this.subset(r, url.searchParams))
        : this.send(
            res,
            404,
            outcome('not-found', `${type}/${id} is not known`),
          );
    }

    if (method === 'POST' && id === undefined) {
      const r = json();
      if (r.resourceType !== type)
        return this.send(res, 400, outcome('invalid', `a ${type} expected`));
      const ifNone = req.headers['if-none-exist'];
      if (typeof ifNone === 'string') {
        const found = [...this.store.values()]
          .map(v => v.at(-1))
          .find(
            x =>
              x &&
              x.resourceType === type &&
              new URLSearchParams(ifNone).get('identifier') ===
                x.identifier?.[0]?.value,
          );
        if (found) return this.send(res, 200, found);
      }
      const stored = this.put({ ...r, id: String(this.nextId++) });
      const location = `${this.baseUrl}/${type}/${stored.id}/_history/1`;
      return this.minimal
        ? this.send(res, 201, undefined, { Location: location })
        : this.send(res, 201, stored, { Location: location });
    }

    if (method === 'PUT') {
      const r = json();
      if (r.id !== id)
        return this.send(
          res,
          400,
          outcome('invalid', 'the id of the body is not the one of the URL'),
        );
      const cur = this.current(type, id);
      const ifMatch = req.headers['if-match'];
      if (
        typeof ifMatch === 'string' &&
        cur &&
        ifMatch !== `W/"${cur.meta.versionId}"`
      )
        return this.send(
          res,
          412,
          outcome(
            'conflict',
            `version ${cur.meta.versionId} is current, not ${ifMatch}`,
          ),
        );
      const stored = this.put(r);
      return this.minimal
        ? this.send(res, cur ? 200 : 201, undefined, {
            'Content-Location': `${this.baseUrl}/${type}/${id}/_history/${stored.meta.versionId}`,
          })
        : this.send(res, cur ? 200 : 201, stored);
    }

    if (method === 'PATCH') {
      const cur = this.current(type, id);
      if (!cur)
        return this.send(
          res,
          404,
          outcome('not-found', `${type}/${id} is not known`),
        );
      if (req.headers['content-type'] !== 'application/json-patch+json')
        return this.send(res, 415, outcome('not-supported', 'JSON Patch only'));
      const next = structuredClone(cur);
      for (const o of json()) {
        const keys = o.path.split('/').slice(1);
        let at: any = next;
        for (const k of keys.slice(0, -1)) at = at[k];
        at[keys.at(-1)] = o.value;
      }
      return this.send(res, 200, this.put(next));
    }

    if (method === 'DELETE') {
      const versions = this.store.get(`${type}/${id}`);
      if (versions) versions.push(null);
      return this.send(res, 204);
    }

    return this.send(res, 405, outcome('not-supported', `${method} ${path}`));
  }
}
