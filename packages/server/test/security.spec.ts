import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FhirContext } from '@fhirjs/core';
import { r4Model } from '@fhirjs/r4';
import { expect } from 'expect';
import {
  checked,
  type FhirAuthenticator,
  type FhirAuthorizer,
  type FhirRequestContext,
  FhirServer,
  FhirServerError,
  IntrospectionAuthenticator,
  JwtAuthenticator,
  MemoryStore,
  nodeListener,
  type StoredResource,
} from '../src/index.js';

const fhir = new FhirContext(r4Model);
const b64url = (b: ArrayBuffer | string) =>
  Buffer.from(typeof b === 'string' ? b : new Uint8Array(b)).toString(
    'base64url',
  );

/** An authorization server on 127.0.0.1: OpenID configuration, JWK Set, introspection */
class TestIssuer {
  url = '';
  private _server?: http.Server;
  private _key?: CryptoKeyPair;
  private _jwk?: JsonWebKey;
  /** Tokens introspection calls active, with their answer */
  active = new Map<string, Record<string, unknown>>();
  introspections = 0;

  async start() {
    this._key = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    this._jwk = {
      ...(await crypto.subtle.exportKey('jwk', this._key.publicKey)),
      kid: 'k1',
      alg: 'RS256',
      use: 'sig',
    } as JsonWebKey;
    this._server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/.well-known/openid-configuration')
        res.end(
          JSON.stringify({ issuer: this.url, jwks_uri: `${this.url}/jwks` }),
        );
      else if (req.url === '/jwks')
        res.end(JSON.stringify({ keys: [this._jwk] }));
      else if (req.url === '/introspect' && req.method === 'POST') {
        this.introspections++;
        if (
          req.headers.authorization !==
          `Basic ${Buffer.from('fhir-server:secret').toString('base64')}`
        ) {
          res.statusCode = 401;
          res.end('{}');
          return;
        }
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
          const token = new URLSearchParams(body).get('token') ?? '';
          res.end(JSON.stringify(this.active.get(token) ?? { active: false }));
        });
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>(r => this._server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this._server!.address() as AddressInfo).port}`;
  }
  stop() {
    return new Promise<void>(r => this._server!.close(() => r()));
  }
  async token(
    claims: Record<string, unknown>,
    key = this._key!,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const h = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
    const c = b64url(
      JSON.stringify({ iss: this.url, iat: now, exp: now + 300, ...claims }),
    );
    const sig = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key.privateKey,
      new TextEncoder().encode(`${h}.${c}`),
    );
    return `${h}.${c}.${b64url(sig)}`;
  }
}

/** Integrations come in with an API key */
const apiKeys: FhirAuthenticator = {
  challenge: 'ApiKey',
  async authenticate(request) {
    const key = request.headers.get('X-Api-Key');
    if (key === null) return;
    if (key !== 'integration-key')
      throw new FhirServerError(401, 'The API key is not known', 'login');
    return {
      subject: 'integration',
      method: 'api-key',
      scopes: ['admin'],
      claims: {},
    };
  },
};

/**
 * A rule of a hospital's own: a patient sees their own record and
 * observations; only admins delete
 */
const ownRecords: FhirAuthorizer = {
  async authorize(access) {
    if (
      access.interaction === 'delete' &&
      !access.principal?.scopes.includes('admin')
    )
      return { allowed: false, reason: 'Only admins delete' };
    const patient = access.principal?.patient;
    if (patient && access.interaction === 'search')
      return {
        allowed: true,
        criteria:
          access.type === 'Patient'
            ? `_id=${patient}`
            : `subject=Patient/${patient}`,
      };
    return { allowed: true };
  },
  async authorizeResource(access, resource) {
    const patient = access.principal?.patient;
    if (!patient) return true;
    if (resource.resourceType === 'Patient') return resource.id === patient;
    return resource.subject?.reference === `Patient/${patient}`;
  },
};

/** A memory store that tells who asked */
class WatchedStore extends MemoryStore {
  readers: (string | undefined)[] = [];
  async read(
    type: string,
    id: string,
    context?: FhirRequestContext,
  ): Promise<StoredResource | undefined> {
    this.readers.push(context?.principal?.subject);
    return super.read(type, id);
  }
}

describe('FhirServer security', () => {
  const issuer = new TestIssuer();
  const sessions = new Set(['s1']);
  let sessionChecks = 0;
  const store = new WatchedStore();
  let base: string;
  let stop: () => Promise<void>;

  const call = (path: string, init: RequestInit & { token?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
    return fetch(`${base}/${path}`, { ...init, headers });
  };
  const admin = (path: string, init: RequestInit = {}) =>
    call(path, {
      ...init,
      headers: {
        'X-Api-Key': 'integration-key',
        'Content-Type': 'application/fhir+json',
        ...(init.headers as any),
      },
    });
  const outcome = async (r: Response) => {
    const json = await r.json();
    return `${r.status} ${json.issue.map((i: any) => i.diagnostics).join('; ')}`;
  };
  /** A user's token: a patient's when `patient` is given */
  const userToken = (extra: Record<string, unknown> = {}) =>
    issuer.token({
      sub: 'user-1',
      aud: base,
      sid: 's1',
      scope: 'openid patient/*.rs',
      ...extra,
    });

  before(async () => {
    await issuer.start();
    const jwt = new JwtAuthenticator({ issuer: issuer.url });
    // users: the JWT, then the session it belongs to must be open (as a Redis check would)
    const users = checked(jwt, principal => {
      sessionChecks++;
      if (!sessions.has(principal.claims.sid as string))
        throw new FhirServerError(401, 'The session has ended', 'login');
    });
    const server = new FhirServer({
      fhir,
      store,
      base: '/fhir',
      security: {
        authenticators: [users, apiKeys],
        authorizer: ownRecords,
        smartConfiguration: {
          issuer: issuer.url,
          authorization_endpoint: `${issuer.url}/authorize`,
          token_endpoint: `${issuer.url}/token`,
          capabilities: ['launch-standalone', 'permission-v2'],
        },
      },
    });
    const httpServer = http.createServer(nodeListener(server));
    await new Promise<void>(r => httpServer.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/fhir`;
    stop = () => new Promise<void>(r => httpServer.close(() => r()));
    // the data, written by the integration
    for (const r of [
      { resourceType: 'Patient', id: 'p1', active: true },
      { resourceType: 'Patient', id: 'p2', active: true },
      {
        resourceType: 'Observation',
        id: 'o1',
        status: 'final',
        code: { text: 'a' },
        subject: { reference: 'Patient/p1' },
      },
      {
        resourceType: 'Observation',
        id: 'o2',
        status: 'final',
        code: { text: 'b' },
        subject: { reference: 'Patient/p2' },
      },
    ])
      expect(
        (
          await admin(`${r.resourceType}/${r.id}`, {
            method: 'PUT',
            body: JSON.stringify(r),
          })
        ).status,
      ).toBe(201);
  });
  after(async () => {
    await stop();
    await issuer.stop();
  });

  it('serves metadata and the SMART configuration to anyone, and says how to authenticate', async () => {
    const cs = await (await call('metadata')).json();
    expect(cs.rest[0].security.service[0].coding[0].code).toBe('SMART-on-FHIR');
    expect(
      fhir.validate(cs).issues.filter((i: any) => i.severity === 'error'),
    ).toEqual([]);
    expect(cs.rest[0].security.extension[0].extension).toEqual([
      { url: 'authorize', valueUri: `${issuer.url}/authorize` },
      { url: 'token', valueUri: `${issuer.url}/token` },
    ]);
    const smart = await call('.well-known/smart-configuration');
    expect(smart.headers.get('Content-Type')).toMatch(/^application\/json/);
    expect((await smart.json()).capabilities).toEqual([
      'launch-standalone',
      'permission-v2',
    ]);
  });

  it('answers 401 without credentials, with every challenge', async () => {
    const r = await call('Patient/p1');
    expect(r.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="fhir", ApiKey',
    );
    expect(await outcome(r)).toBe('401 Authentication is required');
  });

  it('takes a valid JWT whose session is open, for the server as audience', async () => {
    const r = await call('Patient/p1', {
      token: await userToken({ patient: undefined }),
    });
    expect(r.status).toBe(200);
    expect(store.readers.at(-1)).toBe('user-1');
  });

  it('refuses a token it cannot take with invalid_token, and stops there', async () => {
    const forged = await issuer.token(
      { sub: 'user-1', aud: base, sid: 's1' },
      (await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      )) as CryptoKeyPair,
    );
    const checks = sessionChecks;
    const answers = [
      await call('Patient/p1', {
        token: await userToken({ aud: 'https://other.example/fhir' }),
      }),
      await call('Patient/p1', {
        token: await userToken({ exp: Math.floor(Date.now() / 1000) - 600 }),
      }),
      // a bad token does not fall through to the API key, even with one
      await call('Patient/p1', {
        token: forged,
        headers: { 'X-Api-Key': 'integration-key' },
      }),
    ];
    expect(answers[0].headers.get('WWW-Authenticate')).toBe(
      `Bearer realm="fhir", error="invalid_token", error_description="The access token is for https://other.example/fhir, not ${base}"`,
    );
    expect(await Promise.all(answers.map(outcome))).toEqual([
      `401 The access token is for https://other.example/fhir, not ${base}`,
      '401 The access token has expired',
      '401 The signature of the access token is not valid',
    ]);
    // the session store is not asked for tokens refused before it
    expect(sessionChecks).toBe(checks);
  });

  it('refuses a valid JWT whose session has ended, at once', async () => {
    const token = await userToken();
    expect((await call('Patient/p1', { token })).status).toBe(200);
    sessions.delete('s1');
    try {
      expect(await outcome(await call('Patient/p1', { token }))).toBe(
        '401 The session has ended',
      );
    } finally {
      sessions.add('s1');
    }
  });

  it('takes an API key, refuses a wrong one', async () => {
    expect((await admin('Patient/p1')).status).toBe(200);
    expect(store.readers.at(-1)).toBe('integration');
    expect(
      await outcome(
        await call('Patient/p1', { headers: { 'X-Api-Key': 'wrong' } }),
      ),
    ).toBe('401 The API key is not known');
  });

  it("restricts a patient's token to their own records", async () => {
    const token = await userToken({ patient: 'p1' });
    const ids = async (path: string) =>
      ((await (await call(path, { token })).json()).entry ?? [])
        .map((e: any) => e.resource.id)
        .sort();
    // search: the authorizer's criteria are added, and not in the links
    expect(await ids('Observation')).toEqual(['o1']);
    expect(await ids('Patient')).toEqual(['p1']);
    const bundle = await (
      await call('Observation?status=final', { token })
    ).json();
    expect(bundle.link[0].url).toBe(
      `${base}/Observation?status=final&_count=50`,
    );
    // read: another patient's record is not there
    expect((await call('Observation/o1', { token })).status).toBe(200);
    expect(await outcome(await call('Observation/o2', { token }))).toBe(
      '404 Observation/o2 is not known',
    );
    expect((await call('Patient/p2', { token })).status).toBe(404);
    // history: another patient's versions are left out
    expect(
      (
        (await (await call('Observation/_history', { token })).json()).entry ??
        []
      ).map((e: any) => e.resource.id),
    ).toEqual(['o1']);
    // writes: not to another patient's record
    const json = {
      headers: { 'Content-Type': 'application/fhir+json' },
      token,
    };
    expect(
      await outcome(
        await call('Observation', {
          ...json,
          method: 'POST',
          body: JSON.stringify({
            resourceType: 'Observation',
            status: 'final',
            code: { text: 'x' },
            subject: { reference: 'Patient/p2' },
          }),
        }),
      ),
    ).toBe('403 The Observation is not one the caller may write');
    expect(
      (
        await call('Observation/o2', {
          ...json,
          method: 'PUT',
          body: JSON.stringify({
            resourceType: 'Observation',
            id: 'o2',
            status: 'final',
            code: { text: 'x' },
            subject: { reference: 'Patient/p1' },
          }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call('Observation', {
          ...json,
          method: 'POST',
          body: JSON.stringify({
            resourceType: 'Observation',
            status: 'final',
            code: { text: 'mine' },
            subject: { reference: 'Patient/p1' },
          }),
        })
      ).status,
    ).toBe(201);
    // conditional: another patient's record is not found by the criteria
    expect(
      (
        await call('Observation?code:text=b', {
          ...json,
          method: 'PUT',
          body: JSON.stringify({
            resourceType: 'Observation',
            status: 'final',
            code: { text: 'b' },
            subject: { reference: 'Patient/p1' },
          }),
        })
      ).status,
    ).toBe(201);
    expect((await admin('Observation/o2')).status).toBe(200);
  });

  it('refuses what the authorizer does not allow, with its reason (403)', async () => {
    expect(
      await outcome(
        await call('Observation/o1', {
          method: 'DELETE',
          token: await userToken(),
        }),
      ),
    ).toBe('403 Only admins delete');
    expect((await admin('Observation/o1', { method: 'DELETE' })).status).toBe(
      204,
    );
  });
});

describe('FhirServer security: anonymous callers', () => {
  it('lets them through to the authorizer, which may allow them', async () => {
    const server = new FhirServer({
      fhir,
      store: new MemoryStore(),
      resources: ['Patient'],
      security: { authenticators: [apiKeys], anonymous: true },
    });
    expect(
      (await server.handle(new Request('http://localhost/Patient'))).status,
    ).toBe(200);
    expect(
      (
        await server.handle(
          new Request('http://localhost/Patient', {
            headers: { 'X-Api-Key': 'wrong' },
          }),
        )
      ).status,
    ).toBe(401);
  });
});

describe('IntrospectionAuthenticator', () => {
  const issuer = new TestIssuer();
  before(() => issuer.start());
  after(() => issuer.stop());

  it('asks the authorization server, keeps the answer, and refuses tokens not active', async () => {
    const auth = new IntrospectionAuthenticator({
      endpoint: `${issuer.url}/introspect`,
      clientId: 'fhir-server',
      clientSecret: 'secret',
    });
    issuer.active.set('opaque-1', {
      active: true,
      sub: 'user-2',
      client_id: 'app',
      scope: 'patient/*.rs launch/patient',
      patient: 'p9',
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const request = (token: string) =>
      new Request('http://localhost/fhir/Patient', {
        headers: { Authorization: `Bearer ${token}` },
      });
    const before = issuer.introspections;
    const p = await auth.authenticate(request('opaque-1'));
    expect(p).toMatchObject({
      subject: 'user-2',
      method: 'introspection',
      scopes: ['patient/*.rs', 'launch/patient'],
      patient: 'p9',
      clientId: 'app',
    });
    await auth.authenticate(request('opaque-1'));
    expect(issuer.introspections - before).toBe(1);
    await expect(auth.authenticate(request('revoked'))).rejects.toThrow(
      'The access token is not active',
    );
    expect(
      await auth.authenticate(new Request('http://localhost/fhir/Patient')),
    ).toBeUndefined();
  });

  it('refuses an endpoint that is not https', () => {
    expect(
      () =>
        new IntrospectionAuthenticator({
          endpoint: 'http://auth.example.org/introspect',
          clientId: 'x',
          clientSecret: 'y',
        }),
    ).toThrow(
      'The introspection endpoint http://auth.example.org/introspect is not https',
    );
  });
});
