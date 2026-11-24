/**
 * Bulk Data export (FHIR Bulk Data Access IG 2.0): `$export` of the whole
 * server, of the patients, or of a group's patients, as NDJSON files. A
 * kick-off answers 202 with a status URL; the export runs in the server's
 * process through the store's search, a page at a time, and writes its
 * files to an ExportStorage; the status answers 202 until the manifest.
 * Design: docs/decisions/bulk-export.md.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { FhirServerError } from './fhir-server-error.js';
import type { StoredResource, StoredVersion } from './fhir-store.js';
import type { FhirPrincipal, FhirRequestContext } from './security.js';
import type { Subset } from './subset.js';

/** Where the files of an export are written and read back */
export interface ExportStorage {
  /** A file to write, one line a resource */
  create(jobId: string, file: string): Promise<ExportWriter>;
  /** A file written; undefined when there is none */
  read(
    jobId: string,
    file: string,
  ): Promise<ReadableStream<Uint8Array> | undefined>;
  /** Deletes every file of an export */
  delete(jobId: string): Promise<void>;
  /**
   * A URL of its own for a file (a signed URL of an object store), given in
   * the manifest instead of the server's; the server serves the file when
   * not given
   */
  url?(jobId: string, file: string): Promise<string>;
}

export interface ExportWriter {
  write(line: string): Promise<void>;
  close(): Promise<void>;
}

/** A file of an export, as the manifest lists it */
export interface ExportFile {
  type: string;
  file: string;
  count: number;
}

/** An export: what it was asked for, and where it stands */
export interface ExportJob {
  id: string;
  status: 'in-progress' | 'completed' | 'failed';
  /** The kick-off request's URL */
  request: string;
  /** Who asked: only they may see its status and files; none on a server without security */
  owner?: string;
  /** Resources changed after it are not in the export */
  transactionTime: string;
  level: 'system' | 'patient' | 'group';
  /** The group of a group export */
  group?: string;
  /** The types exported, in order */
  types: string[];
  /** _since */
  since?: string;
  /** _typeFilter: the queries of a type, any of which a resource matches */
  filters?: Record<string, string[]>;
  /** _elements, as asked */
  elements?: string[];
  /** The patients of `patient` (a POST's), known: the export is of them only */
  patients?: string[];
  /** includeAssociatedData: the Provenance of the resources exported, the latest or all */
  associated?: 'latest' | 'relevant';
  /** The type being exported: 'Observation (3 of 5)' */
  progress?: string;
  output: ExportFile[];
  /** Files of OperationOutcomes: types left out, and why */
  error: ExportFile[];
  /**
   * Files of Bundles of the resources deleted since _since; only for an
   * export of the server with _since
   */
  deleted?: ExportFile[];
  /** Why it failed */
  failure?: string;
  /** When it ended; its files are deleted `keep` after */
  ended?: string;
}

/** Where exports are kept between the kick-off and their files' deletion */
export interface ExportJobStore {
  get(id: string): Promise<ExportJob | undefined>;
  put(job: ExportJob): Promise<void>;
  delete(id: string): Promise<void>;
  /** Every export, to delete those whose files are past `keep` */
  list(): Promise<ExportJob[]>;
}

export interface BulkExportOptions {
  /** Where the files are written */
  storage: ExportStorage;
  /** Where the exports are kept; in memory when not given */
  jobs?: ExportJobStore;
  /** Resources a file has at most (default 10000) */
  fileSize?: number;
  /** Resources a search page of the export reads (default 500) */
  pageSize?: number;
  /** Milliseconds the files are kept after an export ends (default an hour) */
  keep?: number;
  /** Seconds a client is told to wait before asking again (Retry-After, default 5) */
  retryAfter?: number;
  /**
   * Exports this process runs at once, at most; a kick-off past it answers
   * 429 with Retry-After. No limit when not given.
   */
  maxExports?: number;
  /**
   * The patients of a group, by id: for a store without Group resources (a
   * facade's own list). The server reads the Group's `member` when not
   * given. Undefined: no such group.
   */
  groupMembers?(
    id: string,
    context: FhirRequestContext,
  ): Promise<string[] | undefined>;
}

/** What the export asks of the server it runs in */
export interface ExportHost {
  /** The types it serves that can be searched */
  searchable(): string[];
  /** Whether a type is searched by a parameter */
  hasParam(type: string, code: string): boolean;
  /** The parameters that put a type in the Patient compartment */
  compartmentParams(type: string): readonly string[];
  /** The authorizer's decision of a search of a type */
  authorize(
    principal: FhirPrincipal | undefined,
    type: string,
  ): Promise<{ allowed: boolean; reason?: string; criteria?: string }>;
  /**
   * Checks a query of _typeFilter as a search of the caller: 400 for a
   * parameter the type is not searched by or one of the results (_sort,
   * _include ...), 403 for a chain to a type the caller may not search
   */
  filter(
    type: string,
    query: string,
    context: FhirRequestContext,
    baseUrl: string,
  ): Promise<void>;
  /**
   * _elements read for the types exported: 400 for an element no type has,
   * when strict; undefined when it asks for no part
   */
  subset(
    elements: readonly string[],
    types: readonly string[],
    strict: boolean,
  ): Subset | undefined;
  /**
   * A page of a type's history since an instant, newest first; undefined
   * when the store keeps none, or the caller may not read all of it
   */
  history(
    type: string,
    since: string,
    count: number,
    offset: number,
    context: FhirRequestContext,
  ): Promise<StoredVersion[] | undefined>;
  /**
   * Whether the caller may know of a resource deleted: one it may see the
   * version before the deletion of
   */
  deletable(
    type: string,
    id: string,
    context: FhirRequestContext,
  ): Promise<boolean>;
  /**
   * A page of a search, with the authorizer's criteria; `baseUrl` is the
   * server's, for references absolute under it
   */
  search(
    type: string,
    params: URLSearchParams,
    count: number,
    offset: number,
    context: FhirRequestContext,
    baseUrl: string,
  ): Promise<{ items: StoredResource[]; total?: number }>;
  /** A resource, for a Group's members; undefined when not there or not served */
  read(
    type: string,
    id: string,
    context: FhirRequestContext,
  ): Promise<Record<string, any> | undefined>;
  /** A stored resource as the server writes it, the part a subset asks for */
  json(s: StoredResource, subset?: Subset): Record<string, any>;
}

const NDJSON = 'application/fhir+ndjson';
const OUTPUT_FORMATS = new Set([NDJSON, 'application/ndjson', 'ndjson']);
const SUPPORTED = new Set([
  '_outputFormat',
  '_since',
  '_type',
  '_typeFilter',
  '_elements',
  'patient',
  'includeAssociatedData',
]);
const LATEST = 'LatestProvenanceResources';
const RELEVANT = 'RelevantProvenanceResources';
/** Ids in one search of a group's patients */
const BATCH = 100;

/** The exports this process runs: their caller, and whether they were cancelled */
interface Running {
  context: FhirRequestContext;
  /** The server's base URL, as the kick-off came */
  baseUrl: string;
  cancelled: boolean;
  done?: Promise<void>;
}

/** $export, its status and its files, for a FhirServer */
export class BulkExport {
  private readonly _jobs: ExportJobStore;
  private readonly _running = new Map<string, Running>();

  constructor(
    readonly options: BulkExportOptions,
    private readonly _host: ExportHost,
  ) {
    this._jobs = options.jobs ?? new MemoryExportJobStore();
  }

  /** Waits for the exports this process runs: for tests and a graceful stop */
  async idle(): Promise<void> {
    await Promise.all([...this._running.values()].map(r => r.done));
  }

  /**
   * The kick-off: checks the request, starts the export and answers 202
   * with its status URL
   */
  async kickOff(
    request: Request,
    url: URL,
    baseUrl: string,
    context: FhirRequestContext,
    level: ExportJob['level'],
    group?: string,
  ): Promise<Response> {
    await this._sweep();
    const prefer = request.headers.get('Prefer') ?? '';
    if (!/(^|[;,\s])respond-async($|[;,\s])/.test(prefer))
      throw new FhirServerError(
        400,
        '$export is asynchronous: it needs Prefer: respond-async',
        'not-supported',
      );
    const lenient = /(^|[;,\s])handling=lenient($|[;,\s])/.test(prefer);
    const params = await exportParams(request, url);
    for (const name of params.keys())
      if (!SUPPORTED.has(name) && !lenient)
        throw new FhirServerError(
          400,
          `$export: ${name} is not supported`,
          'not-supported',
        );
    const format = params.get('_outputFormat');
    if (format && !OUTPUT_FORMATS.has(format))
      throw new FhirServerError(
        400,
        `$export: _outputFormat ${format} is not supported; ${NDJSON} is`,
        'not-supported',
      );
    const since = params.get('_since') ?? undefined;
    if (since !== undefined && Number.isNaN(Date.parse(since)))
      throw new FhirServerError(
        400,
        `$export: _since ${since} is not an instant`,
        'value',
      );
    const host = this._host;
    // notes for the error files: what was left out, and why
    const notes: { type?: string; why: string }[] = [];

    // patient: the patients of the export, by a POST's references; those not
    // known (or not in the group) are refused, or left out when lenient
    const asks = params.getAll('patient');
    let patients: string[] | undefined;
    if (asks.length) {
      // left out, any of these would export more than was asked
      if (level === 'system')
        throw new FhirServerError(
          400,
          '$export: patient is for the export of the patients or a group',
          'not-supported',
        );
      if (request.method.toUpperCase() !== 'POST')
        throw new FhirServerError(
          400,
          '$export: patient is taken in a POST only',
          'not-supported',
        );
      const ids = asks.map(ref => {
        const m = /(?:^|\/)Patient\/([A-Za-z0-9\-.]{1,64})$/.exec(ref);
        if (!m || (ref.includes('://') && !ref.startsWith(`${baseUrl}/`)))
          throw new FhirServerError(
            400,
            `$export: patient ${ref} is not a reference to a Patient of this server`,
            'value',
          );
        return m[1];
      });
      const members =
        level === 'group'
          ? new Set((await this._members(group!, context)) ?? [])
          : undefined;
      const unknown: string[] = [];
      patients = [];
      for (const id of [...new Set(ids)])
        if (members ? members.has(id) : await host.read('Patient', id, context))
          patients.push(id);
        else unknown.push(id);
      const why = (id: string) =>
        members
          ? `Patient/${id} is not a member of Group/${group}`
          : `Patient/${id} is not known`;
      if (unknown.length && !lenient)
        throw new FhirServerError(
          400,
          `$export: ${unknown.map(why).join('; ')}`,
          'not-found',
          unknown.map(id => ({
            severity: 'error',
            code: 'not-found',
            diagnostics: why(id),
          })),
        );
      for (const id of unknown) notes.push({ why: why(id) });
    }

    const asked = params
      .getAll('_type')
      .flatMap(t => t.split(','))
      .map(t => t.trim())
      .filter(Boolean);

    // the types: those asked, or every one of the level
    const ofLevel =
      level === 'system'
        ? host.searchable()
        : host
            .searchable()
            .filter(
              t => t === 'Patient' || host.compartmentParams(t).length > 0,
            );
    const types: string[] = [];
    for (const type of asked.length ? [...new Set(asked)] : ofLevel) {
      let why: string | undefined;
      if (!ofLevel.includes(type))
        why =
          level === 'system'
            ? `${type} is not served, or not searched`
            : `${type} is not in the Patient compartment, or not searched`;
      else if (since !== undefined && !host.hasParam(type, '_lastUpdated'))
        why = `${type} cannot be searched by _lastUpdated, which _since needs`;
      else if (
        (level === 'group' || patients) &&
        type !== 'Patient' &&
        !host.compartmentParams(type).some(p => host.hasParam(type, p))
      )
        why = `${type} cannot be searched by a parameter of its patient`;
      else {
        const d = await host.authorize(context.principal, type);
        if (!d.allowed) {
          if (asked.length)
            throw new FhirServerError(
              403,
              d.reason ?? `Export of ${type} is not allowed`,
              'forbidden',
            );
          why = `${type} is not allowed to the caller`;
        }
      }
      if (why) {
        if (asked.length)
          throw new FhirServerError(400, `$export: ${why}`, 'not-supported');
        notes.push({ type, why });
        continue;
      }
      types.push(type);
    }

    // includeAssociatedData: the Provenance of what is exported; the least
    // restrictive of the values asked
    const codes = params
      .getAll('includeAssociatedData')
      .flatMap(v => v.split(','))
      .map(v => v.trim())
      .filter(Boolean);
    let associated: ExportJob['associated'];
    if (codes.length) {
      for (const code of codes)
        if (code !== LATEST && code !== RELEVANT) {
          const why = `includeAssociatedData ${code} is not supported; ${LATEST} and ${RELEVANT} are`;
          if (!lenient)
            throw new FhirServerError(400, `$export: ${why}`, 'not-supported');
          notes.push({ why });
        }
      if (codes.includes(RELEVANT)) associated = 'relevant';
      else if (codes.includes(LATEST)) associated = 'latest';
    }
    if (associated) {
      let why: string | undefined;
      if (!host.hasParam('Provenance', 'target'))
        why = 'Provenance is not served, or not searched by target';
      else {
        const d = await host.authorize(context.principal, 'Provenance');
        if (!d.allowed) {
          if (!lenient)
            throw new FhirServerError(
              403,
              d.reason ?? 'Export of Provenance is not allowed',
              'forbidden',
            );
          why = 'Provenance is not allowed to the caller';
        }
      }
      if (why) {
        if (!lenient)
          throw new FhirServerError(
            400,
            `$export: includeAssociatedData: ${why}`,
            'not-supported',
          );
        notes.push({ why: `includeAssociatedData: ${why}` });
        associated = undefined;
      }
    }
    if (associated && types.includes('Provenance')) {
      // the Provenance of the export is what includeAssociatedData says
      if (asked.includes('Provenance'))
        throw new FhirServerError(
          400,
          '$export: Provenance comes with includeAssociatedData; it is not asked in _type too',
          'not-supported',
        );
      types.splice(types.indexOf('Provenance'), 1);
    }

    // _typeFilter: Type?query, repeated or split at a comma before the next type
    const filters: Record<string, string[]> = {};
    for (const value of params.getAll('_typeFilter'))
      for (const f of value.split(/,(?=[A-Z][A-Za-z]*\?)/)) {
        const m = /^([A-Z][A-Za-z]*)\?(.+)$/s.exec(f.trim());
        if (!m)
          throw new FhirServerError(
            400,
            `$export: _typeFilter ${f} is not [type]?[query]`,
            'value',
          );
        const [, type, query] = m;
        if (!types.includes(type)) {
          // left out already, with its reason in the error files
          if (notes.some(l => l.type === type) || lenient) continue;
          throw new FhirServerError(
            400,
            `$export: _typeFilter ${f}: ${type} is not exported`,
            'not-supported',
          );
        }
        // a query the server cannot apply is refused, lenient or not: left
        // out, it would export more than was asked
        await host.filter(type, query, context, baseUrl);
        (filters[type] ??= []).push(query);
      }
    const elements = params
      .getAll('_elements')
      .flatMap(v => v.split(','))
      .map(v => v.trim())
      .filter(Boolean);
    if (elements.length)
      host.subset(
        elements,
        associated ? [...types, 'Provenance'] : types,
        !lenient,
      );

    const max = this.options.maxExports;
    if (max !== undefined && this._running.size >= max)
      throw Object.assign(
        new FhirServerError(
          429,
          `The server runs ${max} exports at once; ask again later`,
          'throttled',
        ),
        { headers: { 'Retry-After': String(this.options.retryAfter ?? 5) } },
      );

    if (
      level === 'group' &&
      (await this._members(group!, context)) === undefined
    )
      throw new FhirServerError(
        404,
        `Group/${group} is not known`,
        'not-found',
      );

    const job: ExportJob = {
      id: crypto.randomUUID(),
      status: 'in-progress',
      request: url.href,
      owner: ownerOf(context.principal),
      transactionTime: new Date().toISOString(),
      level,
      group,
      types,
      since,
      filters: Object.keys(filters).length ? filters : undefined,
      elements: elements.length ? elements : undefined,
      patients,
      associated,
      output: [],
      error: [],
      // deleted resources: the history of a type says which, not whose
      // they were, so for the server's export only
      deleted: level === 'system' && since !== undefined ? [] : undefined,
    };
    await this._jobs.put(job);
    const running: Running = { context, baseUrl, cancelled: false };
    this._running.set(job.id, running);
    running.done = this._run(job, running, notes).finally(() => {
      this._running.delete(job.id);
    });
    return new Response(null, {
      status: 202,
      headers: { 'Content-Location': `${baseUrl}/$export-status/${job.id}` },
    });
  }

  /** GET of the status URL: 202 while it runs, the manifest when done */
  async status(
    id: string,
    baseUrl: string,
    principal: FhirPrincipal | undefined,
  ): Promise<Response> {
    await this._sweep();
    const job = await this._own(id, principal);
    if (job.status === 'in-progress' && !this._running.has(id)) {
      // started by a process that is gone
      job.status = 'failed';
      job.failure = 'The server stopped while the export ran';
      job.ended = new Date().toISOString();
      await this._jobs.put(job);
    }
    if (job.status === 'in-progress')
      return new Response(null, {
        status: 202,
        headers: {
          'X-Progress': job.progress ?? 'starting',
          'Retry-After': String(this.options.retryAfter ?? 5),
        },
      });
    if (job.status === 'failed')
      throw new FhirServerError(
        500,
        `The export failed: ${job.failure}`,
        'exception',
      );
    const storage = this.options.storage;
    const files = async (list: ExportFile[]) =>
      Promise.all(
        list.map(async f => ({
          type: f.type,
          url: storage.url
            ? await storage.url(job.id, f.file)
            : `${baseUrl}/$export-file/${job.id}/${f.file}`,
          count: f.count,
        })),
      );
    const manifest = {
      transactionTime: job.transactionTime,
      request: job.request,
      requiresAccessToken: !storage.url && job.owner !== undefined,
      output: await files(job.output),
      error: await files(job.error),
      ...(job.deleted && { deleted: await files(job.deleted) }),
    };
    return new Response(JSON.stringify(manifest), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Expires: new Date(
          Date.parse(job.ended!) + (this.options.keep ?? 3_600_000),
        ).toUTCString(),
      },
    });
  }

  /** DELETE of the status URL: the export stopped, its files deleted */
  async cancel(
    id: string,
    principal: FhirPrincipal | undefined,
  ): Promise<Response> {
    const job = await this._own(id, principal);
    const running = this._running.get(job.id);
    if (running) running.cancelled = true;
    else await this._remove(job.id);
    return new Response(null, { status: 202 });
  }

  /** GET of a file: its lines */
  async file(
    id: string,
    file: string,
    principal: FhirPrincipal | undefined,
  ): Promise<Response> {
    await this._sweep();
    const job = await this._own(id, principal);
    const listed =
      job.status === 'completed' &&
      [...job.output, ...job.error, ...(job.deleted ?? [])].some(
        f => f.file === file,
      );
    const body = listed && (await this.options.storage.read(job.id, file));
    if (!body) throw new FhirServerError(404, `No file ${file}`, 'not-found');
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': NDJSON },
    });
  }

  /** The export of the caller: 404 for another's, as for one that is not there */
  private async _own(
    id: string,
    principal: FhirPrincipal | undefined,
  ): Promise<ExportJob> {
    const job = await this._jobs.get(id);
    if (!job || job.owner !== ownerOf(principal))
      throw new FhirServerError(404, `No export ${id}`, 'not-found');
    return job;
  }

  /** Deletes the exports whose files are past `keep` */
  private async _sweep(): Promise<void> {
    const keep = this.options.keep ?? 3_600_000;
    const now = Date.now();
    for (const job of await this._jobs.list())
      if (job.ended && Date.parse(job.ended) + keep <= now)
        await this._remove(job.id);
  }

  private async _remove(id: string): Promise<void> {
    await this.options.storage.delete(id);
    await this._jobs.delete(id);
  }

  /** The patients of a group, by id */
  private async _members(
    group: string,
    context: FhirRequestContext,
  ): Promise<string[] | undefined> {
    if (this.options.groupMembers)
      return this.options.groupMembers(group, context);
    const g = await this._host.read('Group', group, context);
    if (!g) return;
    return (g.member ?? [])
      .map((m: any) => /^Patient\/([^/]+)$/.exec(m.entity?.reference ?? ''))
      .filter(Boolean)
      .map((m: RegExpExecArray) => m[1]);
  }

  /** Runs an export: every type, a page at a time, into files */
  private async _run(
    job: ExportJob,
    running: Running,
    notes: { type?: string; why: string }[],
  ): Promise<void> {
    const storage = this.options.storage;
    const fileSize = this.options.fileSize ?? 10_000;
    const provenance = job.associated
      ? {
          files: new TypeFiles(job, storage, 'Provenance', fileSize),
          seen: new Set<string>(),
        }
      : undefined;
    try {
      if (notes.length) {
        const w = await storage.create(job.id, 'OperationOutcome-1.ndjson');
        for (const { why } of notes)
          await w.write(
            JSON.stringify({
              resourceType: 'OperationOutcome',
              issue: [
                {
                  severity: 'warning',
                  code: 'not-supported',
                  diagnostics: why,
                },
              ],
            }),
          );
        await w.close();
        job.error.push({
          type: 'OperationOutcome',
          file: 'OperationOutcome-1.ndjson',
          count: notes.length,
        });
      }
      let members =
        job.level === 'group'
          ? ((await this._members(job.group!, running.context)) ?? [])
          : undefined;
      if (job.patients)
        members = members
          ? members.filter(id => job.patients!.includes(id))
          : job.patients;
      const subset = job.elements
        ? this._host.subset(
            job.elements,
            job.associated ? [...job.types, 'Provenance'] : job.types,
            false,
          )
        : undefined;
      for (const [i, type] of job.types.entries()) {
        if (running.cancelled) break;
        job.progress = `${type} (${i + 1} of ${job.types.length})`;
        await this._jobs.put(job);
        await this._type(job, running, type, members, subset, provenance);
        if (job.deleted) await this._deleted(job, running, type);
      }
      await provenance?.files.close();
      if (running.cancelled) {
        await this._remove(job.id);
        return;
      }
      job.status = 'completed';
    } catch (e) {
      if (running.cancelled) {
        await this._remove(job.id);
        return;
      }
      job.status = 'failed';
      job.failure =
        e instanceof FhirServerError ? e.message : 'an error of the server';
    } finally {
      await provenance?.files.close();
    }
    job.progress = undefined;
    job.ended = new Date().toISOString();
    await this._jobs.put(job);
  }

  /** One type's resources, into files of `fileSize` */
  private async _type(
    job: ExportJob,
    running: Running,
    type: string,
    members: string[] | undefined,
    subset: Subset | undefined,
    provenance: Provenances | undefined,
  ): Promise<void> {
    const host = this._host;
    const files = new TypeFiles(
      job,
      this.options.storage,
      type,
      this.options.fileSize ?? 10_000,
    );
    // _typeFilter's queries, any of which a resource matches
    const queries = job.filters?.[type] ?? [''];
    // a resource found by more than one search is written once
    const seen = members || queries.length > 1 ? new Set<string>() : undefined;
    /** Writes a resource; false when written already */
    const write = async (s: StoredResource) => {
      if (seen) {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
      }
      await files.write(JSON.stringify(host.json(s, subset)));
      return true;
    };

    // the searches: every resource, or those of the group's patients
    const searches: URLSearchParams[] = [];
    // no upper bound at transactionTime: a store's clock (a database's now())
    // may run ahead of the server's, and the bound would leave out what was
    // written before the kick-off, which the export must have
    for (const query of queries) {
      const base = () => {
        const p = new URLSearchParams(query);
        if (job.since) p.append('_lastUpdated', `gt${job.since}`);
        return p;
      };
      if (!members) searches.push(base());
      else
        for (let i = 0; i < members.length; i += BATCH) {
          const ids = members.slice(i, i + BATCH);
          if (type === 'Patient') {
            const p = base();
            p.append('_id', ids.join(','));
            searches.push(p);
            continue;
          }
          for (const param of host.compartmentParams(type)) {
            if (!host.hasParam(type, param)) continue;
            const p = base();
            p.append(param, ids.map(id => `Patient/${id}`).join(','));
            searches.push(p);
          }
        }
    }

    try {
      for (const params of searches)
        await this._pages(type, params, running, async items => {
          const written: string[] = [];
          for (const s of items)
            if (s.resource && (await write(s))) written.push(`${type}/${s.id}`);
          if (provenance && written.length)
            await this._provenance(job, running, written, provenance, subset);
        });
    } finally {
      await files.close();
    }
  }

  /** The pages of a search, to their end or a cancel */
  private async _pages(
    type: string,
    params: URLSearchParams,
    running: Running,
    each: (items: StoredResource[]) => Promise<void>,
  ): Promise<void> {
    const pageSize = this.options.pageSize ?? 500;
    for (let offset = 0; ; offset += pageSize) {
      if (running.cancelled) return;
      const page = await this._host.search(
        type,
        params,
        pageSize,
        offset,
        running.context,
        running.baseUrl,
      );
      await each(page.items);
      if (
        page.items.length < pageSize ||
        (page.total !== undefined && offset + pageSize >= page.total)
      )
        return;
    }
  }

  /**
   * includeAssociatedData: the Provenance whose target is one of the
   * resources written, each once; for 'latest', the one recorded last of
   * each resource
   */
  private async _provenance(
    job: ExportJob,
    running: Running,
    refs: string[],
    provenance: Provenances,
    subset: Subset | undefined,
  ): Promise<void> {
    for (let i = 0; i < refs.length; i += BATCH) {
      const batch = refs.slice(i, i + BATCH);
      const found: StoredResource[] = [];
      await this._pages(
        'Provenance',
        new URLSearchParams({ target: batch.join(',') }),
        running,
        async items => void found.push(...items.filter(s => s.resource)),
      );
      let chosen = found;
      if (job.associated === 'latest') {
        const latest = new Map<string, StoredResource>();
        for (const s of found)
          for (const ref of targets(s.resource!))
            if (batch.includes(ref)) {
              const had = latest.get(ref);
              if (!had || recorded(s) > recorded(had)) latest.set(ref, s);
            }
        chosen = found.filter(s => [...latest.values()].includes(s));
      }
      for (const s of chosen) {
        if (provenance.seen.has(s.id)) continue;
        provenance.seen.add(s.id);
        await provenance.files.write(
          JSON.stringify(this._host.json(s, subset)),
        );
      }
    }
  }

  /**
   * The resources of a type deleted since _since, as Bundles of DELETE
   * entries, a Bundle a page of its history: a resource whose newest
   * version is a deletion
   */
  private async _deleted(
    job: ExportJob,
    running: Running,
    type: string,
  ): Promise<void> {
    const pageSize = this.options.pageSize ?? 500;
    const seen = new Set<string>();
    let writer: ExportWriter | undefined;
    let file: ExportFile | undefined;
    try {
      for (let offset = 0; ; offset += pageSize) {
        if (running.cancelled) return;
        const page = await this._host.history(
          type,
          job.since!,
          pageSize,
          offset,
          running.context,
        );
        if (!page) return;
        const gone: string[] = [];
        // newest first: the first version of an id is its newest
        for (const v of page) {
          if (v.type !== type || seen.has(v.id)) continue;
          seen.add(v.id);
          if (
            v.method === 'DELETE' &&
            (await this._host.deletable(type, v.id, running.context))
          )
            gone.push(v.id);
        }
        if (gone.length) {
          if (!writer) {
            file = { type: 'Bundle', file: `${type}-deleted.ndjson`, count: 0 };
            writer = await this.options.storage.create(job.id, file.file);
            job.deleted!.push(file);
          }
          await writer.write(
            JSON.stringify({
              resourceType: 'Bundle',
              type: 'transaction',
              entry: gone.map(id => ({
                request: { method: 'DELETE', url: `${type}/${id}` },
              })),
            }),
          );
          file!.count++;
        }
        if (page.length < pageSize) return;
      }
    } finally {
      await writer?.close();
    }
  }
}

/** The kick-off's parameters: of the URL, and of a POST's Parameters */
async function exportParams(
  request: Request,
  url: URL,
): Promise<URLSearchParams> {
  const params = new URLSearchParams(url.search);
  for (const k of [...params.keys()]) if (k === '_format') params.delete(k);
  if (request.method.toUpperCase() !== 'POST') return params;
  const text = await request.text();
  if (!text) return params;
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new FhirServerError(400, 'The body is not JSON', 'structure');
  }
  if (body?.resourceType !== 'Parameters')
    throw new FhirServerError(
      400,
      '$export takes a Parameters resource',
      'structure',
    );
  for (const p of body.parameter ?? []) {
    const value: any = Object.entries(p).find(([k]) =>
      k.startsWith('value'),
    )?.[1];
    params.append(
      p.name,
      typeof value === 'string'
        ? value
        : // patient's valueReference: the reference
          typeof value?.reference === 'string'
          ? value.reference
          : JSON.stringify(value),
    );
  }
  return params;
}

function ownerOf(principal: FhirPrincipal | undefined): string | undefined {
  return principal
    ? JSON.stringify([
        principal.method,
        principal.subject,
        principal.clientId ?? null,
      ])
    : undefined;
}

/** Exports kept in memory: lost with the process */
export class MemoryExportJobStore implements ExportJobStore {
  private readonly _jobs = new Map<string, ExportJob>();

  async get(id: string) {
    const job = this._jobs.get(id);
    return job && structuredClone(job);
  }

  async put(job: ExportJob) {
    this._jobs.set(job.id, structuredClone(job));
  }

  async delete(id: string) {
    this._jobs.delete(id);
  }

  async list() {
    return [...this._jobs.values()].map(j => structuredClone(j));
  }
}

/** Files kept in memory: for tests and small exports */
export class MemoryExportStorage implements ExportStorage {
  private readonly _files = new Map<string, Map<string, string[]>>();

  async create(jobId: string, file: string): Promise<ExportWriter> {
    const lines: string[] = [];
    let files = this._files.get(jobId);
    if (!files) this._files.set(jobId, (files = new Map()));
    files.set(file, lines);
    return {
      write: async line => void lines.push(line),
      close: async () => {},
    };
  }

  async read(jobId: string, file: string) {
    const lines = this._files.get(jobId)?.get(file);
    if (!lines) return;
    const text = lines.map(l => l + '\n').join('');
    return new Response(text).body!;
  }

  async delete(jobId: string) {
    this._files.delete(jobId);
  }

  /** The exports with files, by id: for tests */
  get jobs(): string[] {
    return [...this._files.keys()];
  }
}

/** Files in a folder of the file system: a folder an export */
export class FileExportStorage implements ExportStorage {
  constructor(readonly dir: string) {}

  async create(jobId: string, file: string): Promise<ExportWriter> {
    const folder = join(this.dir, safe(jobId));
    await mkdir(folder, { recursive: true });
    const stream = createWriteStream(join(folder, safe(file)));
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve());
      stream.once('error', reject);
    });
    return {
      write: line =>
        new Promise<void>((resolve, reject) => {
          stream.write(line + '\n', e => (e ? reject(e) : resolve()));
        }),
      close: () =>
        new Promise<void>((resolve, reject) => {
          stream.end((e?: Error | null) => (e ? reject(e) : resolve()));
        }),
    };
  }

  async read(jobId: string, file: string) {
    const path = join(this.dir, safe(jobId), safe(file));
    const stream = createReadStream(path);
    try {
      await new Promise<void>((resolve, reject) => {
        stream.once('open', () => resolve());
        stream.once('error', reject);
      });
    } catch {
      return;
    }
    return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  }

  async delete(jobId: string) {
    await rm(join(this.dir, safe(jobId)), { recursive: true, force: true });
  }
}

/** A name kept to one segment of a path */
function safe(name: string): string {
  if (!/^[A-Za-z0-9\-._]+$/.test(name) || name.startsWith('.'))
    throw new FhirServerError(404, `No file ${name}`, 'not-found');
  return name;
}

/** includeAssociatedData's Provenance: its files, and those written */
interface Provenances {
  files: TypeFiles;
  seen: Set<string>;
}

/** A type's files of an export, of `size` resources at most: Observation-1.ndjson ... */
class TypeFiles {
  private _writer?: ExportWriter;
  private _current?: ExportFile;

  constructor(
    private readonly _job: ExportJob,
    private readonly _storage: ExportStorage,
    readonly type: string,
    private readonly _size: number,
  ) {}

  async write(line: string): Promise<void> {
    if (!this._writer || this._current!.count === this._size) {
      await this._writer?.close();
      const n = this._job.output.filter(f => f.type === this.type).length + 1;
      this._current = {
        type: this.type,
        file: `${this.type}-${n}.ndjson`,
        count: 0,
      };
      this._writer = await this._storage.create(
        this._job.id,
        this._current.file,
      );
      this._job.output.push(this._current);
    }
    await this._writer.write(line);
    this._current!.count++;
  }

  async close(): Promise<void> {
    const w = this._writer;
    this._writer = undefined;
    await w?.close();
  }
}

/** The references of a Provenance's targets, relative: 'Observation/1' */
function targets(p: Record<string, any>): string[] {
  return (p.target ?? [])
    .map((t: any) =>
      /([A-Za-z]+\/[A-Za-z0-9\-.]{1,64})(?:\/_history\/[^/]+)?$/.exec(
        t?.reference ?? '',
      ),
    )
    .filter(Boolean)
    .map((m: RegExpExecArray) => m[1]);
}

/** When a Provenance was recorded, to find the latest */
function recorded(s: StoredResource): number {
  return Date.parse(s.resource?.recorded ?? s.lastUpdated ?? '') || 0;
}
