/*
 * A small SMART authorization server for the client's tests:
 * .well-known/smart-configuration, an authorize endpoint that grants at once
 * (redirects back with a code), and a token endpoint for client_credentials
 * (checks the JWT assertion's signature with the registered public key, its
 * claims and that its jti is new), authorization_code (checks PKCE and the
 * redirect URI) and refresh_token. Tokens are access-1, access-2 ...
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

interface Grant {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scope: string;
  nonce?: string;
}

const b64urlDecode = (s: string) =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export class SmartTestServer {
  baseUrl = '';
  /** Clients of backend services: id -> public JWK and its algorithm */
  readonly backendClients = new Map<
    string,
    { jwk: JsonWebKey; alg: 'RS384' | 'ES384' }
  >();
  /** Clients of app launch: id -> secret (undefined: a public client) */
  readonly appClients = new Map<string, string | undefined>();
  readonly tokenRequests: {
    headers: http.IncomingHttpHeaders;
    form: URLSearchParams;
  }[] = [];
  /** Access tokens live this many seconds */
  expiresIn = 3600;
  private readonly codes = new Map<string, Grant>();
  private readonly refreshTokens = new Set<string>();
  private readonly jtis = new Set<string>();
  private issued = 0;
  /** The key id_tokens are signed with (RS256), made at start; its public half is in the JWK Set */
  private signing?: { privateKey: CryptoKey; publicJwk: JsonWebKey };
  /** The fhirUser of id_tokens */
  fhirUser = 'Practitioner/pr1';
  /** Claims to change in the next id_tokens (aud, exp, iss ...), for the tests that must fail */
  idTokenClaims: Record<string, unknown> = {};
  /** Sign id_tokens with another key than the published one */
  wrongKey = false;
  /** Times the JWK Set was read */
  jwksReads = 0;

  get issuer() {
    return `${this.baseUrl}/auth`;
  }

  /** A signed id_token for a client */
  async idToken(clientId: string, nonce?: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: this.issuer,
      sub: 'user-1',
      aud: clientId,
      exp: now + 300,
      iat: now,
      fhirUser: this.fhirUser,
      ...(nonce ? { nonce } : {}),
      ...this.idTokenClaims,
    };
    const enc = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString('base64url');
    const input = `${enc({ alg: 'RS256', typ: 'JWT', kid: 'id-1' })}.${enc(claims)}`;
    const key = this.wrongKey
      ? (
          (await crypto.subtle.generateKey(
            {
              name: 'RSASSA-PKCS1-v1_5',
              modulusLength: 2048,
              publicExponent: new Uint8Array([1, 0, 1]),
              hash: 'SHA-256',
            },
            false,
            ['sign', 'verify'],
          )) as CryptoKeyPair
        ).privateKey
      : this.signing!.privateKey;
    const sig = await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      new TextEncoder().encode(input),
    );
    return `${input}.${Buffer.from(sig).toString('base64url')}`;
  }
  private server?: http.Server;

  get tokenEndpoint() {
    return `${this.baseUrl}/auth/token`;
  }

  async start(): Promise<string> {
    const pair = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    this.signing = {
      privateKey: pair.privateKey,
      publicJwk: {
        ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
        kid: 'id-1',
        alg: 'RS256',
        use: 'sig',
      } as JsonWebKey,
    };
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () =>
        this.handle(req, body)
          .then(([status, json, headers]) => {
            res.writeHead(status, {
              ...(json ? { 'Content-Type': 'application/json' } : {}),
              ...headers,
            });
            res.end(json ? JSON.stringify(json) : undefined);
          })
          .catch(e => {
            res.writeHead(500);
            res.end(String(e));
          }),
      );
    });
    await new Promise<void>(r => this.server!.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.baseUrl;
  }

  async stop() {
    await new Promise<void>(r => this.server?.close(() => r()));
  }

  private issue(extra: Record<string, unknown> = {}) {
    this.issued++;
    return {
      access_token: `access-${this.issued}`,
      token_type: 'bearer',
      expires_in: this.expiresIn,
      ...extra,
    };
  }

  private async handle(
    req: http.IncomingMessage,
    body: string,
  ): Promise<[number, any?, Record<string, string>?]> {
    const url = new URL(req.url!, this.baseUrl);
    if (url.pathname === '/fhir/.well-known/smart-configuration')
      return [
        200,
        {
          issuer: `${this.baseUrl}/auth`,
          authorization_endpoint: `${this.baseUrl}/auth/authorize`,
          token_endpoint: this.tokenEndpoint,
          token_endpoint_auth_methods_supported: [
            'private_key_jwt',
            'client_secret_basic',
          ],
          grant_types_supported: [
            'authorization_code',
            'client_credentials',
            'refresh_token',
          ],
          code_challenge_methods_supported: ['S256'],
          capabilities: [
            'launch-ehr',
            'launch-standalone',
            'client-public',
            'client-confidential-symmetric',
          ],
        },
      ];

    if (url.pathname === '/auth/.well-known/openid-configuration')
      return [
        200,
        {
          issuer: this.issuer,
          jwks_uri: `${this.baseUrl}/auth/jwks`,
          id_token_signing_alg_values_supported: ['RS256'],
        },
      ];
    if (url.pathname === '/auth/jwks') {
      this.jwksReads++;
      return [200, { keys: [this.signing!.publicJwk] }];
    }

    if (url.pathname === '/auth/authorize') {
      const p = url.searchParams;
      const redirect = new URL(p.get('redirect_uri')!);
      if (!this.appClients.has(p.get('client_id')!)) {
        redirect.searchParams.set('error', 'unauthorized_client');
        redirect.searchParams.set('state', p.get('state') ?? '');
        return [302, undefined, { Location: redirect.toString() }];
      }
      if (
        p.get('code_challenge_method') !== 'S256' ||
        p.get('response_type') !== 'code' ||
        !p.get('aud')
      )
        return [400, { error: 'invalid_request' }];
      const code = `code-${this.codes.size + 1}`;
      this.codes.set(code, {
        clientId: p.get('client_id')!,
        redirectUri: p.get('redirect_uri')!,
        challenge: p.get('code_challenge')!,
        scope: p.get('scope')!,
        nonce: p.get('nonce') ?? undefined,
      });
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', p.get('state')!);
      return [302, undefined, { Location: redirect.toString() }];
    }

    if (url.pathname === '/auth/token' && req.method === 'POST') {
      const form = new URLSearchParams(body);
      this.tokenRequests.push({ headers: req.headers, form });
      switch (form.get('grant_type')) {
        case 'client_credentials':
          return this.clientCredentials(form);
        case 'authorization_code':
          return this.authorizationCode(form, req.headers.authorization);
        case 'refresh_token': {
          const t = form.get('refresh_token')!;
          if (!this.refreshTokens.has(t))
            return [
              400,
              {
                error: 'invalid_grant',
                error_description: 'unknown refresh token',
              },
            ];
          return [200, this.issue()];
        }
      }
      return [400, { error: 'unsupported_grant_type' }];
    }
    return [404];
  }

  private async clientCredentials(
    form: URLSearchParams,
  ): Promise<[number, any?]> {
    const fail = (d: string): [number, any] => [
      401,
      { error: 'invalid_client', error_description: d },
    ];
    if (
      form.get('client_assertion_type') !==
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
    )
      return fail('no JWT assertion');
    const [h, p, sig] = (form.get('client_assertion') ?? '').split('.');
    const header = JSON.parse(b64urlDecode(h).toString());
    const claims = JSON.parse(b64urlDecode(p).toString());
    const client = this.backendClients.get(claims.iss);
    if (!client || claims.sub !== claims.iss) return fail('unknown client');
    if (header.alg !== client.alg) return fail(`alg ${header.alg}`);
    const params =
      client.alg === 'RS384'
        ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' }
        : { name: 'ECDSA', namedCurve: 'P-384', hash: 'SHA-384' };
    const key = await crypto.subtle.importKey(
      'jwk',
      client.jwk,
      params,
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      params,
      key,
      b64urlDecode(sig),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return fail('bad signature');
    if (claims.aud !== this.tokenEndpoint) return fail('wrong aud');
    const now = Date.now() / 1000;
    if (!(claims.exp > now && claims.exp <= now + 300)) return fail('bad exp');
    if (this.jtis.has(claims.jti)) return fail('jti used before');
    this.jtis.add(claims.jti);
    return [200, this.issue({ scope: form.get('scope') })];
  }

  private async authorizationCode(
    form: URLSearchParams,
    authorization?: string,
  ): Promise<[number, any?]> {
    const grant = this.codes.get(form.get('code') ?? '');
    if (!grant)
      return [
        400,
        { error: 'invalid_grant', error_description: 'unknown code' },
      ];
    this.codes.delete(form.get('code')!); // a code is good once
    const secret = this.appClients.get(grant.clientId);
    if (secret !== undefined) {
      const expected = `Basic ${btoa(`${grant.clientId}:${secret}`)}`;
      if (authorization !== expected) return [401, { error: 'invalid_client' }];
    } else if (form.get('client_id') !== grant.clientId)
      return [401, { error: 'invalid_client' }];
    if (form.get('redirect_uri') !== grant.redirectUri)
      return [
        400,
        { error: 'invalid_grant', error_description: 'redirect_uri' },
      ];
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(form.get('code_verifier') ?? ''),
    );
    const challenge = Buffer.from(digest).toString('base64url');
    if (challenge !== grant.challenge)
      return [400, { error: 'invalid_grant', error_description: 'PKCE' }];
    const refresh = `refresh-${this.refreshTokens.size + 1}`;
    this.refreshTokens.add(refresh);
    return [
      200,
      this.issue({
        scope: grant.scope,
        refresh_token: refresh,
        patient: 'p1',
        encounter: 'e1',
        ...(/(^|\s)openid(\s|$)/.test(grant.scope)
          ? { id_token: await this.idToken(grant.clientId, grant.nonce) }
          : {}),
      }),
    ];
  }
}
