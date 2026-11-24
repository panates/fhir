import { FhirContext } from '@fhirjs/core';
import { r4Model } from '@fhirjs/r4';
import { expect } from 'expect';
import {
  bearerToken,
  discoverSmart,
  FhirClient,
  SmartAppLaunch,
  SmartAuthError,
  SmartBackendServices,
  type SmartConfiguration,
  verifyIdToken,
} from '../src/index.js';
import { SmartTestServer } from './_support/smart-test-server.js';
import { TestFhirServer } from './_support/test-server.js';

/** A key pair made for the test, as the client would register its public key */
async function keyPair(alg: 'RS384' | 'ES384') {
  const params =
    alg === 'RS384'
      ? {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-384',
        }
      : { name: 'ECDSA', namedCurve: 'P-384' };
  const pair = (await crypto.subtle.generateKey(params, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
  };
}

describe('SMART on FHIR', () => {
  const auth = new SmartTestServer();
  const fhirServer = new TestFhirServer();
  const fhir = new FhirContext(r4Model);
  let config: SmartConfiguration;

  before(async () => {
    await auth.start();
    await fhirServer.start();
    config = await discoverSmart(`${auth.baseUrl}/fhir`);
  });
  after(async () => {
    await auth.stop();
    await fhirServer.stop();
  });
  beforeEach(() => fhirServer.reset());

  it('discovers the endpoints', () => {
    expect(config.token_endpoint).toBe(auth.tokenEndpoint);
    expect(config.authorization_endpoint).toBe(
      `${auth.baseUrl}/auth/authorize`,
    );
  });

  describe('backend services', () => {
    for (const alg of ['RS384', 'ES384'] as const)
      it(`gets a token with a JWT assertion signed ${alg}, and the FHIR server takes it`, async () => {
        const { privateKey, publicJwk } = await keyPair(alg);
        auth.backendClients.set(`backend-${alg}`, { jwk: publicJwk, alg });
        const backend = new SmartBackendServices({
          tokenEndpoint: config.token_endpoint,
          clientId: `backend-${alg}`,
          key: privateKey,
          alg,
          kid: 'k1',
          scope: 'system/Patient.rs',
        });
        const token = await backend.provider(false);
        expect(token).toMatch(/^access-\d+$/);
        const form = auth.tokenRequests.at(-1)!.form;
        expect(form.get('scope')).toBe('system/Patient.rs');
        expect(
          JSON.parse(
            Buffer.from(
              form.get('client_assertion')!.split('.')[0],
              'base64url',
            ).toString(),
          ),
        ).toEqual({
          alg,
          typ: 'JWT',
          kid: 'k1',
        });

        fhirServer.token = token;
        const client = new FhirClient({
          baseUrl: fhirServer.baseUrl,
          fhir,
          interceptors: [bearerToken(backend.provider)],
        });
        expect((await client.capabilities()).resourceType).toBe(
          'CapabilityStatement',
        );
        // cached: no second token request
        const before = auth.tokenRequests.length;
        await client.capabilities();
        expect(auth.tokenRequests.length).toBe(before);
      });

    it('takes a private JWK; a new assertion (jti) for each token', async () => {
      const { privateJwk, publicJwk } = await keyPair('ES384');
      auth.backendClients.set('jwk-client', { jwk: publicJwk, alg: 'ES384' });
      const backend = new SmartBackendServices({
        tokenEndpoint: config.token_endpoint,
        clientId: 'jwk-client',
        key: privateJwk,
        alg: 'ES384',
        scope: 'system/*.rs',
      });
      const a = await backend.provider(false);
      const b = await backend.provider(true); // a refresh: the server refuses a jti it has seen
      expect(a).not.toBe(b);
    });

    it("refuses a public key, and reports the server's refusal", async () => {
      const { publicJwk } = await keyPair('ES384');
      const pub = new SmartBackendServices({
        tokenEndpoint: config.token_endpoint,
        clientId: 'x',
        key: publicJwk,
        alg: 'ES384',
        scope: 's',
      });
      await expect(pub.provider(false)).rejects.toThrow(
        'a private key signs the assertion',
      );

      const { privateKey } = await keyPair('ES384');
      const unknown = new SmartBackendServices({
        tokenEndpoint: config.token_endpoint,
        clientId: 'nobody',
        key: privateKey,
        alg: 'ES384',
        scope: 's',
      });
      const e = await Promise.resolve(unknown.provider(false)).then(
        () => undefined,
        (x: SmartAuthError) => x,
      );
      expect(e).toBeInstanceOf(SmartAuthError);
      expect(e!.status).toBe(401);
      expect(e!.error).toBe('invalid_client');
      expect(e!.message).toBe(
        'Token request failed: 401 (invalid_client: unknown client)',
      );
    });

    it('sends assertions and secrets only over https (or to localhost)', () => {
      expect(
        () =>
          new SmartBackendServices({
            tokenEndpoint: 'http://auth.example.org/token',
            clientId: 'x',
            key: {} as JsonWebKey,
            alg: 'ES384',
            scope: 's',
          }),
      ).toThrow(
        'The token endpoint http://auth.example.org/token is not https',
      );
    });
  });

  describe('app launch', () => {
    const redirectUri = 'https://app.example.org/callback';
    const launch = (clientSecret?: string) =>
      new SmartAppLaunch({
        configuration: config,
        fhirBaseUrl: fhirServer.baseUrl,
        clientId: clientSecret ? 'confidential-app' : 'public-app',
        clientSecret,
        redirectUri,
        scope: 'launch openid fhirUser patient/*.rs offline_access',
      });
    before(() => {
      auth.appClients.set('public-app', undefined);
      auth.appClients.set('confidential-app', 's3cret');
    });

    /** The user agrees: the authorize URL redirects back with a code */
    const authorizeAndReturn = async (url: string) => {
      const res = await fetch(url, { redirect: 'manual' });
      return res.headers.get('Location')!;
    };

    it('builds the authorize URL with PKCE (S256), state, aud and (for openid) a nonce', async () => {
      const { url, pending } = await launch().authorize({ launch: 'xyz' });
      const p = new URL(url).searchParams;
      expect(Object.fromEntries(p)).toEqual({
        response_type: 'code',
        client_id: 'public-app',
        redirect_uri: redirectUri,
        scope: 'launch openid fhirUser patient/*.rs offline_access',
        state: pending.state,
        aud: fhirServer.baseUrl,
        launch: 'xyz',
        code_challenge: p.get('code_challenge'),
        code_challenge_method: 'S256',
        nonce: pending.nonce,
      });
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(pending.codeVerifier),
      );
      expect(p.get('code_challenge')).toBe(
        Buffer.from(digest).toString('base64url'),
      );
    });

    it('trades the code for tokens and the launch context; the client uses them', async () => {
      const app = launch();
      const { url, pending } = await app.authorize();
      const session = await app.callback(
        await authorizeAndReturn(url),
        pending,
      );
      expect(session).toMatchObject({
        patient: 'p1',
        encounter: 'e1',
        refreshToken: expect.stringMatching(/^refresh-/),
      });
      expect(auth.tokenRequests.at(-1)!.form.get('client_id')).toBe(
        'public-app',
      );

      fhirServer.token = session.accessToken;
      const client = new FhirClient({
        baseUrl: fhirServer.baseUrl,
        fhir,
        interceptors: [bearerToken(app.provider(session))],
      });
      expect((await client.capabilities()).resourceType).toBe(
        'CapabilityStatement',
      );
    });

    it('a confidential client authenticates with its secret (Basic)', async () => {
      const app = launch('s3cret');
      const { url, pending } = await app.authorize();
      const session = await app.callback(
        await authorizeAndReturn(url),
        pending,
      );
      expect(session.accessToken).toMatch(/^access-/);
      const req = auth.tokenRequests.at(-1)!;
      expect(req.headers.authorization).toBe(
        `Basic ${btoa('confidential-app:s3cret')}`,
      );
      expect(req.form.has('client_id')).toBe(false);
    });

    it('refuses a callback whose state is not the one sent, and one with an error', async () => {
      const app = launch();
      const { url, pending } = await app.authorize();
      const back = await authorizeAndReturn(url);
      await expect(
        app.callback(back, { ...pending, state: 'other' }),
      ).rejects.toThrow('the request may be forged');
      await expect(
        app.callback(
          `${redirectUri}?error=access_denied&state=${pending.state}`,
          pending,
        ),
      ).rejects.toThrow('Authorization refused: access_denied');
    });

    it('refreshes the token when the FHIR server refuses it, and tells of the new session', async () => {
      const app = launch();
      const { url, pending } = await app.authorize();
      const session = await app.callback(
        await authorizeAndReturn(url),
        pending,
      );
      const sessions: string[] = [];
      const client = new FhirClient({
        baseUrl: fhirServer.baseUrl,
        fhir,
        interceptors: [
          bearerToken(app.provider(session, s => sessions.push(s.accessToken))),
        ],
      });
      // the server now takes only the next token the auth server issues
      const next = Number(session.accessToken.split('-')[1]) + 1;
      fhirServer.token = `access-${next}`;
      await client.capabilities();
      expect(sessions).toEqual([`access-${next}`]);
      expect(auth.tokenRequests.at(-1)!.form.get('grant_type')).toBe(
        'refresh_token',
      );
    });

    it('needs a server that takes S256', () => {
      expect(
        () =>
          new SmartAppLaunch({
            configuration: {
              ...config,
              code_challenge_methods_supported: ['plain'],
            },
            fhirBaseUrl: '',
            clientId: '',
            redirectUri: '',
            scope: '',
          }),
      ).toThrow('does not take PKCE with S256');
    });
  });

  describe('id_token', () => {
    const redirectUri = 'https://app.example.org/callback';
    const app = () =>
      new SmartAppLaunch({
        configuration: config,
        fhirBaseUrl: fhirServer.baseUrl,
        clientId: 'public-app',
        redirectUri,
        scope: 'openid fhirUser patient/*.rs',
      });
    const login = async (a = app()) => {
      const { url, pending } = await a.authorize();
      const back = (await fetch(url, { redirect: 'manual' })).headers.get(
        'Location',
      )!;
      return { session: () => a.callback(back, pending), pending, url };
    };
    afterEach(() => {
      auth.idTokenClaims = {};
      auth.wrongKey = false;
      auth.fhirUser = 'Practitioner/pr1';
    });

    it('verifies it and gives the user: claims, fhirUser, the resource to read', async () => {
      auth.appClients.set('public-app', undefined);
      const { session, pending, url } = await login();
      expect(new URL(url).searchParams.get('nonce')).toBe(pending.nonce);
      const s = await session();
      expect(s.user!.claims).toMatchObject({
        iss: auth.issuer,
        sub: 'user-1',
        aud: 'public-app',
        nonce: pending.nonce,
      });
      expect(s.user!.fhirUser).toBe('Practitioner/pr1');
      expect(s.user!.reference).toEqual({ type: 'Practitioner', id: 'pr1' });

      fhirServer.put({
        resourceType: 'Practitioner',
        id: 'pr1',
        name: [{ family: 'Demir' }],
      });
      fhirServer.token = s.accessToken;
      const client = new FhirClient({
        baseUrl: fhirServer.baseUrl,
        fhir,
        interceptors: [bearerToken(app().provider(s))],
      });
      const me = await client.read(
        s.user!.reference!.type,
        s.user!.reference!.id,
      );
      expect(me.name[0].family).toBe('Demir');
    });

    it('reads an absolute fhirUser on this server; one on another server has no reference', async () => {
      auth.fhirUser = `${fhirServer.baseUrl}/Patient/p9`;
      expect((await (await login()).session()).user!.reference).toEqual({
        type: 'Patient',
        id: 'p9',
      });
      auth.fhirUser = 'https://elsewhere.example/fhir/Patient/p9';
      const user = (await (await login()).session()).user!;
      expect(user.fhirUser).toBe('https://elsewhere.example/fhir/Patient/p9');
      expect(user.reference).toBeUndefined();
    });

    const refused: [string, () => void, string][] = [
      [
        'signed with a key the issuer did not publish',
        () => (auth.wrongKey = true),
        'The signature of the id_token is not valid',
      ],
      [
        'for another client',
        () => (auth.idTokenClaims = { aud: 'other-app' }),
        'The id_token is for other-app, not public-app',
      ],
      [
        'from another issuer',
        () => (auth.idTokenClaims = { iss: 'https://evil.example' }),
        'The id_token comes from https://evil.example',
      ],
      [
        'expired',
        () =>
          (auth.idTokenClaims = { exp: Math.floor(Date.now() / 1000) - 3600 }),
        'The id_token has expired',
      ],
      [
        'with another nonce',
        () => (auth.idTokenClaims = { nonce: 'replayed' }),
        'The nonce of the id_token is not the one sent',
      ],
    ];
    for (const [what, set, message] of refused)
      it(`refuses one ${what}`, async () => {
        set();
        await expect((await login()).session()).rejects.toThrow(message);
      });

    it("refuses 'none' and algorithms not listed, whatever the token says", async () => {
      const enc = (v: unknown) =>
        Buffer.from(JSON.stringify(v)).toString('base64url');
      const claims = {
        iss: auth.issuer,
        sub: 'u',
        aud: 'public-app',
        exp: Date.now() / 1000 + 60,
        iat: Date.now() / 1000,
      };
      for (const alg of ['none', 'HS256'])
        await expect(
          verifyIdToken(`${enc({ alg })}.${enc(claims)}.`, {
            issuer: auth.issuer,
            clientId: 'public-app',
          }),
        ).rejects.toThrow(`The id_token is signed ${alg}, which is not taken`);
    });

    it('keeps the keys, and reads them again for a kid it does not know (rotation)', async () => {
      const issuer = auth.issuer;
      const token = await auth.idToken('public-app');
      const before = auth.jwksReads;
      await verifyIdToken(token, { issuer, clientId: 'public-app' });
      await verifyIdToken(token, { issuer, clientId: 'public-app' });
      expect(auth.jwksReads - before).toBeLessThanOrEqual(1);
      const rotated = token.replace(
        /^[^.]+/,
        Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'id-2' })).toString(
          'base64url',
        ),
      );
      await expect(
        verifyIdToken(rotated, { issuer, clientId: 'public-app' }),
      ).rejects.toThrow('The issuer has no key id-2 for RS256');
      expect(auth.jwksReads - before).toBeGreaterThanOrEqual(1);
    });

    it('can be left unverified for a server known not to sign them', async () => {
      auth.wrongKey = true;
      const a = new SmartAppLaunch({ ...app().options, verifyIdToken: false });
      const s = await (await login(a)).session();
      expect(s.user).toBeUndefined();
      expect(s.idToken).toBeDefined();
    });
  });
});
