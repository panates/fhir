import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FhirServer } from './fhir-server.js';

/**
 * A node:http (and Express) request listener answering with a FhirServer:
 *
 * ```ts
 * http.createServer(nodeListener(server)).listen(8080);
 * app.use('/fhir', nodeListener(server)); // Express: give the server base: '/fhir'
 * ```
 */
export function nodeListener(server: FhirServer) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    toRequest(req)
      .then(request => server.handle(request))
      .then(response => send(res, response))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  };
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const protocol = (req.socket as { encrypted?: boolean }).encrypted
    ? 'https'
    : 'http';
  // Express strips its mount path from url; originalUrl keeps it
  const path = (req as { originalUrl?: string }).originalUrl ?? req.url ?? '/';
  const url = `${protocol}://${req.headers.host ?? 'localhost'}${path}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x);
  }
  const method = req.method ?? 'GET';
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    body = new Uint8Array(Buffer.concat(chunks));
  }
  return new Request(url, { method, headers, body });
}

async function send(res: ServerResponse, response: Response) {
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => (headers[k] = v));
  const body = response.body
    ? Buffer.from(await response.arrayBuffer())
    : undefined;
  res.writeHead(response.status, headers);
  res.end(body);
}
