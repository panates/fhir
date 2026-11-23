/**
 * Bulk Data export from the client's side (FHIR Bulk Data Access IG 2.0):
 * the kick-off, the status asked until the manifest, as the server's
 * Retry-After says, and the files read a line at a time as resources.
 */
import { parseFhirJson } from '@fhirjs/core';
import { FhirClientError } from './fhir-client-error.js';
import type { FhirClient, FhirRequestOptions } from './fhir-client.js';

export interface FhirBulkExportOptions extends FhirRequestOptions {
  /** What to export: the server (default), the patients, or a group's patients */
  level?: 'system' | 'patient' | { group: string };
  /** _type: these types only */
  types?: readonly string[];
  /** _since: what changed after this instant */
  since?: string | Date;
  /** More kick-off parameters (_typeFilter, _elements ...), as the server takes them */
  params?: Record<string, string | readonly string[]>;
}

/** A file of an export */
export interface FhirBulkFile {
  type: string;
  url: string;
  count?: number;
}

/** What a finished export gives: its files */
export interface FhirBulkManifest {
  transactionTime: string;
  request: string;
  /** The files need the client's token: they are read through the client */
  requiresAccessToken: boolean;
  output: FhirBulkFile[];
  /** Files of OperationOutcomes */
  error: FhirBulkFile[];
}

/** Where an export stands */
export type FhirBulkStatus =
  | {
      done: false;
      /** The server's X-Progress */
      progress?: string;
      /** Milliseconds the server asks to wait (Retry-After) */
      retryAfter?: number;
    }
  | { done: true; manifest: FhirBulkManifest };

export interface FhirBulkWaitOptions {
  /** Milliseconds between asks when the server gives no Retry-After (default 2000) */
  interval?: number;
  /** The longest wait between asks, whatever Retry-After says (default 60000) */
  maxInterval?: number;
  /** Called with each X-Progress */
  onProgress?(progress: string | undefined): void;
  signal?: AbortSignal;
}

const NDJSON = 'application/fhir+ndjson';

/**
 * An export the server runs: ask its status, wait for its manifest, read
 * its files as resources, or cancel it
 *
 * ```ts
 * const job = await client.bulkExport({ level: { group: 'ward-3' }, types: ['Patient', 'Observation'] });
 * const manifest = await job.wait();
 * for await (const resource of job.resources(manifest)) ...
 * ```
 */
export class FhirBulkExport {
  constructor(
    private readonly client: FhirClient,
    /** The status URL the server gave (Content-Location) */
    readonly statusUrl: string,
    private readonly options: FhirRequestOptions = {},
  ) {}

  /** Where it stands: its progress, or its manifest when done */
  async status(signal?: AbortSignal): Promise<FhirBulkStatus> {
    const r = await this.client.request('GET', this.statusUrl, {
      ...this.options,
      signal: signal ?? this.options.signal,
      headers: { ...this.options.headers, Accept: 'application/json' },
      okStatus: [429],
    });
    if (r.status === 200) {
      const manifest = await r.json();
      if (!Array.isArray(manifest?.output))
        throw new FhirClientError(
          `${this.statusUrl}: the server's manifest has no output`,
          r.status,
        );
      manifest.error ??= [];
      return { done: true, manifest };
    }
    await r.body?.cancel();
    return {
      done: false,
      progress: r.headers.get('X-Progress') ?? undefined,
      retryAfter: retryAfter(r.headers.get('Retry-After')),
    };
  }

  /** Asks the status until the export is done, waiting as the server asks; its manifest */
  async wait(options: FhirBulkWaitOptions = {}): Promise<FhirBulkManifest> {
    const max = options.maxInterval ?? 60_000;
    for (;;) {
      const s = await this.status(options.signal);
      if (s.done) return s.manifest;
      options.onProgress?.(s.progress);
      await sleep(
        Math.min(s.retryAfter ?? options.interval ?? 2000, max),
        options.signal,
      );
    }
  }

  /** Stops the export, and the server deletes its files */
  async cancel(signal?: AbortSignal): Promise<void> {
    const r = await this.client.request('DELETE', this.statusUrl, {
      ...this.options,
      signal: signal ?? this.options.signal,
      headers: { ...this.options.headers, Accept: 'application/json' },
    });
    await r.body?.cancel();
  }

  /**
   * The resources of the manifest's files (of `types` only, when given), a
   * line at a time, decoded with the client's codec
   */
  async *resources<T = any>(
    manifest: FhirBulkManifest,
    options: { types?: readonly string[]; signal?: AbortSignal } = {},
  ): AsyncGenerator<T> {
    for (const file of manifest.output)
      if (!options.types || options.types.includes(file.type))
        yield* this.read<T>(file, manifest, options.signal);
  }

  /** The OperationOutcomes of the manifest's error files */
  async *errors(
    manifest: FhirBulkManifest,
    signal?: AbortSignal,
  ): AsyncGenerator<any> {
    for (const file of manifest.error) yield* this.read(file, manifest, signal);
  }

  /**
   * The resources of one file. One that needs the token is read through the
   * client (its interceptors, on its server only); another (a signed URL of
   * an object store) without them, so the token goes nowhere else.
   */
  async *read<T = any>(
    file: FhirBulkFile,
    manifest: FhirBulkManifest,
    signal?: AbortSignal,
  ): AsyncGenerator<T> {
    signal ??= this.options.signal;
    let r: Response;
    if (manifest.requiresAccessToken)
      r = await this.client.request('GET', file.url, {
        ...this.options,
        signal,
        headers: { ...this.options.headers, Accept: NDJSON },
      });
    else {
      const f = this.client.options.fetch ?? globalThis.fetch;
      r = await f(file.url, { headers: { Accept: NDJSON }, signal });
      if (!r.ok) {
        await r.body?.cancel();
        throw new FhirClientError(
          `GET ${file.url}: ${r.status} ${r.statusText}`,
          r.status,
          undefined,
          { method: 'GET', url: file.url },
        );
      }
    }
    for await (const line of lines(r))
      yield this.client.decodeJson<T>(parseFhirJson(line));
  }
}

/** The kick-off's path and parameters */
export function exportPath(options: FhirBulkExportOptions): string {
  const level = options.level ?? 'system';
  let path: string;
  if (level === 'system') path = '$export';
  else if (level === 'patient') path = 'Patient/$export';
  else {
    if (!/^[A-Za-z0-9\-.]{1,64}$/.test(level.group))
      throw new TypeError(`"${level.group}" is not a FHIR id`);
    path = `Group/${level.group}/$export`;
  }
  const q = new URLSearchParams();
  if (options.types?.length) q.set('_type', options.types.join(','));
  if (options.since !== undefined)
    q.set(
      '_since',
      options.since instanceof Date
        ? options.since.toISOString()
        : options.since,
    );
  for (const [k, v] of Object.entries(options.params ?? {}))
    for (const x of typeof v === 'string' ? [v] : v) q.append(k, x);
  return q.size ? `${path}?${q}` : path;
}

/** Retry-After in milliseconds: seconds, or an HTTP date */
function retryAfter(h: string | null): number | undefined {
  if (!h) return;
  if (/^\d+$/.test(h.trim())) return Number(h) * 1000;
  const t = Date.parse(h);
  return Number.isNaN(t) ? undefined : Math.max(0, t - Date.now());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** The lines of a body, as they come, without empty ones */
async function* lines(r: Response): AsyncGenerator<string> {
  if (!r.body) return;
  const decoder = new TextDecoder();
  let rest = '';
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    rest += decoder.decode(chunk, { stream: true });
    const parts = rest.split('\n');
    rest = parts.pop()!;
    for (const p of parts) if (p.trim()) yield p;
  }
  rest += decoder.decode();
  if (rest.trim()) yield rest;
}
