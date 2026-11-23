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
import type { StoredResource } from './fhir-store.js';
import type { FhirPrincipal, FhirRequestContext } from './security.js';

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
  /** The type being exported: 'Observation (3 of 5)' */
  progress?: string;
  output: ExportFile[];
  /** Files of OperationOutcomes: types left out, and why */
  error: ExportFile[];
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
  /** A page of a search, with the authorizer's criteria */
  search(
    type: string,
    params: URLSearchParams,
    count: number,
    offset: number,
    context: FhirRequestContext,
  ): Promise<{ items: StoredResource[]; total?: number }>;
  /** A resource, for a Group's members; undefined when not there or not served */
  read(
    type: string,
    id: string,
    context: FhirRequestContext,
  ): Promise<Record<string, any> | undefined>;
  /** A stored resource as the server writes it */
  json(s: StoredResource): Record<string, any>;
}

const NDJSON = 'application/fhir+ndjson';
const OUTPUT_FORMATS = new Set([NDJSON, 'application/ndjson', 'ndjson']);
const SUPPORTED = new Set(['_outputFormat', '_since', '_type']);
/** Ids in one search of a group's patients */
const BATCH = 100;

/** The exports this process runs: their caller, and whether they were cancelled */
interface Running {
  context: FhirRequestContext;
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
    const asked = params
      .getAll('_type')
      .flatMap(t => t.split(','))
      .map(t => t.trim())
      .filter(Boolean);

    // the types: those asked, or every one of the level
    const host = this._host;
    const ofLevel =
      level === 'system'
        ? host.searchable()
        : host
            .searchable()
            .filter(
              t => t === 'Patient' || host.compartmentParams(t).length > 0,
            );
    const types: string[] = [];
    const leftOut: { type: string; why: string }[] = [];
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
        level === 'group' &&
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
        leftOut.push({ type, why });
        continue;
      }
      types.push(type);
    }

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
      output: [],
      error: [],
    };
    await this._jobs.put(job);
    const running: Running = { context, cancelled: false };
    this._running.set(job.id, running);
    running.done = this._run(job, running, leftOut).finally(() => {
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
      [...job.output, ...job.error].some(f => f.file === file);
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
    leftOut: { type: string; why: string }[],
  ): Promise<void> {
    const storage = this.options.storage;
    try {
      if (leftOut.length) {
        const w = await storage.create(job.id, 'OperationOutcome-1.ndjson');
        for (const { why } of leftOut)
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
          count: leftOut.length,
        });
      }
      const members =
        job.level === 'group'
          ? ((await this._members(job.group!, running.context)) ?? [])
          : undefined;
      for (const [i, type] of job.types.entries()) {
        if (running.cancelled) break;
        job.progress = `${type} (${i + 1} of ${job.types.length})`;
        await this._jobs.put(job);
        await this._type(job, running, type, members);
      }
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
  ): Promise<void> {
    const host = this._host;
    const storage = this.options.storage;
    const fileSize = this.options.fileSize ?? 10_000;
    const pageSize = this.options.pageSize ?? 500;
    let writer: ExportWriter | undefined;
    let current: ExportFile | undefined;
    const seen = members ? new Set<string>() : undefined;
    const write = async (s: StoredResource) => {
      if (seen) {
        if (seen.has(s.id)) return;
        seen.add(s.id);
      }
      if (!writer || current!.count === fileSize) {
        await writer?.close();
        current = {
          type,
          file: `${type}-${job.output.filter(f => f.type === type).length + 1}.ndjson`,
          count: 0,
        };
        writer = await storage.create(job.id, current.file);
        job.output.push(current);
      }
      await writer.write(JSON.stringify(host.json(s)));
      current!.count++;
    };

    // the searches: every resource, or those of the group's patients
    const searches: URLSearchParams[] = [];
    // no upper bound at transactionTime: a store's clock (a database's now())
    // may run ahead of the server's, and the bound would leave out what was
    // written before the kick-off, which the export must have
    const base = () => {
      const p = new URLSearchParams();
      if (job.since) p.append('_lastUpdated', `gt${job.since}`);
      return p;
    };
    if (!members) searches.push(base());
    else
      for (let i = 0; i < members.length; i += BATCH) {
        const ids = members.slice(i, i + BATCH);
        if (type === 'Patient') {
          const p = base();
          p.set('_id', ids.join(','));
          searches.push(p);
          continue;
        }
        for (const param of host.compartmentParams(type)) {
          if (!host.hasParam(type, param)) continue;
          const p = base();
          p.set(param, ids.map(id => `Patient/${id}`).join(','));
          searches.push(p);
        }
      }

    try {
      for (const params of searches) {
        for (let offset = 0; ; offset += pageSize) {
          if (running.cancelled) return;
          const page = await host.search(
            type,
            params,
            pageSize,
            offset,
            running.context,
          );
          for (const s of page.items) if (s.resource) await write(s);
          if (
            page.items.length < pageSize ||
            (page.total !== undefined && offset + pageSize >= page.total)
          )
            break;
        }
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
    const value = Object.entries(p).find(([k]) => k.startsWith('value'))?.[1];
    params.append(
      p.name,
      typeof value === 'string' ? value : JSON.stringify(value),
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
