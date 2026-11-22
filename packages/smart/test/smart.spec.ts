import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'expect';
import {
  grantingScopes,
  JwksClient,
  JwtError,
  parseScope,
  parseScopes,
  verifyJwt,
} from '../src/index.js';

const b64url = (b: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof b === 'string' ? b : new Uint8Array(b)).toString(
    'base64url',
  );

const ALGS = {
  RS256: {
    gen: {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    sign: { name: 'RSASSA-PKCS1-v1_5' },
  },
  ES256: {
    gen: { name: 'ECDSA', namedCurve: 'P-256' },
    sign: { name: 'ECDSA', hash: 'SHA-256' },
  },
  PS256: {
    gen: {
      name: 'RSA-PSS',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    sign: { name: 'RSA-PSS', saltLength: 32 },
  },
} as const;
type Alg = keyof typeof ALGS;

interface Key {
  alg: Alg;
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey;
}

async function makeKey(alg: Alg, kid: string): Promise<Key> {
  const pair = (await crypto.subtle.generateKey(ALGS[alg].gen as any, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = {
    ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    kid,
    alg,
    use: 'sig',
  } as JsonWebKey;
  return { alg, kid, privateKey: pair.privateKey, jwk };
}

async function sign(
  key: Key,
  claims: object,
  header: object = {},
): Promise<string> {
  const h = b64url(
    JSON.stringify({ alg: key.alg, kid: key.kid, typ: 'JWT', ...header }),
  );
  const c = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign(
    ALGS[key.alg].sign as any,
    key.privateKey,
    new TextEncoder().encode(`${h}.${c}`),
  );
  return `${h}.${c}.${b64url(sig)}`;
}

/** An authorization server on 127.0.0.1: its OpenID configuration and JWK Set */
class TestIssuer {
  keys: Key[] = [];
  jwksReads = 0;
  configIssuer?: string;
  private _server?: http.Server;
  url = '';

  async start() {
    this._server = http.createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            issuer: this.configIssuer ?? this.url,
            jwks_uri: `${this.url}/jwks`,
          }),
        );
      } else if (req.url === '/jwks') {
        this.jwksReads++;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ keys: this.keys.map(k => k.jwk) }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>(r => this._server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this._server!.address() as AddressInfo).port}`;
  }
  stop() {
    return new Promise<void>(r => this._server!.close(() => r()));
  }
}

describe('verifyJwt()', () => {
  const issuer = new TestIssuer();
  let rs: Key;
  let es: Key;
  let ps: Key;
  const now = () => Math.floor(Date.now() / 1000);
  const claims = (extra: object = {}) => ({
    iss: issuer.url,
    sub: 'user-1',
    aud: 'https://fhir.example.org/fhir',
    exp: now() + 300,
    iat: now(),
    ...extra,
  });
  const options = (keys = new JwksClient({ issuer: issuer.url })) => ({
    keys,
    issuer: issuer.url,
    audience: 'https://fhir.example.org/fhir',
  });
  const refuses = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
    } catch (e) {
      if (e instanceof JwtError) return `${e.code}: ${e.message}`;
      throw e;
    }
    throw new Error('Expected a JwtError');
  };

  before(async () => {
    await issuer.start();
    rs = await makeKey('RS256', 'rs-1');
    es = await makeKey('ES256', 'es-1');
    ps = await makeKey('PS256', 'ps-1');
    issuer.keys = [rs, es, ps];
  });
  after(() => issuer.stop());

  it('verifies RS256, ES256 and PS256, with keys found by the issuer or by jwks_uri', async () => {
    for (const key of [rs, es, ps]) {
      const { header, claims: c } = await verifyJwt(
        await sign(key, claims()),
        options(),
      );
      expect(header).toMatchObject({ alg: key.alg, kid: key.kid });
      expect(c.sub).toBe('user-1');
    }
    const byUri = new JwksClient({ jwksUri: `${issuer.url}/jwks` });
    expect(
      (await verifyJwt(await sign(rs, claims()), options(byUri))).claims.iss,
    ).toBe(issuer.url);
    // an audience among several
    await verifyJwt(
      await sign(
        rs,
        claims({ aud: ['other', 'https://fhir.example.org/fhir'] }),
      ),
      options(),
    );
  });

  it('refuses what it must not take', async () => {
    const other = await makeKey('RS256', 'rs-1'); // the same kid, another key
    const enc = (v: unknown) => b64url(JSON.stringify(v));
    expect([
      await refuses(
        verifyJwt(`${enc({ alg: 'none' })}.${enc(claims())}.`, options()),
      ),
      await refuses(
        verifyJwt(`${enc({ alg: 'HS256' })}.${enc(claims())}.x`, options()),
      ),
      await refuses(
        verifyJwt(
          await sign(rs, claims({ iss: 'https://evil.example' })),
          options(),
        ),
      ),
      await refuses(verifyJwt(await sign(other, claims()), options())),
      await refuses(
        verifyJwt(
          await sign(rs, claims({ aud: 'https://other.example' })),
          options(),
        ),
      ),
      await refuses(
        verifyJwt(await sign(rs, claims({ exp: now() - 120 })), options()),
      ),
      await refuses(
        verifyJwt(await sign(rs, claims({ nbf: now() + 120 })), options()),
      ),
      await refuses(
        verifyJwt(await sign(rs, claims({ iat: now() + 120 })), {
          ...options(),
          requireIat: true,
          name: 'id_token',
        }),
      ),
      await refuses(verifyJwt('a.b', options())),
      await refuses(verifyJwt('!!.!!.!!', options())),
    ]).toEqual([
      'algorithm: The token is signed none, which is not taken',
      'algorithm: The token is signed HS256, which is not taken',
      `issuer: The token comes from https://evil.example, not ${issuer.url}`,
      'signature: The signature of the token is not valid',
      'audience: The token is for https://other.example, not https://fhir.example.org/fhir',
      'expired: The token has expired',
      'not-yet-valid: The token is not valid yet',
      'not-yet-valid: The id_token was issued in the future',
      'malformed: The token is not a signed JWT',
      'malformed: The token cannot be read',
    ]);
    // an algorithm left out of the list given
    expect(
      await refuses(
        verifyJwt(await sign(ps, claims()), {
          ...options(),
          algorithms: ['RS256'],
        }),
      ),
    ).toBe('algorithm: The token is signed PS256, which is not taken');
    // a little clock skew is allowed
    await verifyJwt(await sign(rs, claims({ exp: now() - 30 })), options());
  });

  it('keeps the keys, reads them again for a kid it does not have, but not at every request', async () => {
    const keys = new JwksClient({ issuer: issuer.url });
    const reads = issuer.jwksReads;
    const token = await sign(rs, claims());
    await Promise.all([
      verifyJwt(token, options(keys)),
      verifyJwt(token, options(keys)),
    ]);
    await verifyJwt(token, options(keys));
    expect(issuer.jwksReads - reads).toBe(1);
    // the server rotates its keys: a new kid is read at once ...
    const rotated = await makeKey('RS256', 'rs-2');
    issuer.keys = [...issuer.keys, rotated];
    const keysAfter = new JwksClient({
      issuer: issuer.url,
      minRefetchInterval: 0,
    });
    await verifyJwt(token, options(keysAfter));
    await verifyJwt(await sign(rotated, claims()), options(keysAfter));
    // ... and with the default interval, an unknown kid right after a read does not read again
    const before = issuer.jwksReads;
    const forged = await makeKey('RS256', 'rs-unknown');
    expect(
      await refuses(verifyJwt(await sign(forged, claims()), options(keys))),
    ).toBe('key: The issuer has no key rs-unknown for RS256');
    expect(issuer.jwksReads).toBe(before);
  });

  it('refuses an issuer whose configuration names another, and keys not over https', async () => {
    issuer.configIssuer = 'https://someone.else';
    try {
      expect(
        await refuses(verifyJwt(await sign(rs, claims()), options())),
      ).toBe(
        `key: The OpenID configuration of ${issuer.url} names another issuer, https://someone.else`,
      );
    } finally {
      issuer.configIssuer = undefined;
    }
    const keys = new JwksClient({ jwksUri: 'http://auth.example.org/jwks' });
    expect(await refuses(keys.keys())).toBe(
      'key: The JWK Set http://auth.example.org/jwks is not https',
    );
  });
});

describe('SMART scopes', () => {
  it('reads v1 scopes as the v2 scopes they stand for', () => {
    const perms = (s: string) => [...parseScope(s)!.permissions].join('');
    expect(perms('patient/Observation.read')).toBe('rs');
    expect(perms('user/Patient.write')).toBe('cud');
    expect(perms('system/*.*')).toBe('cruds');
    expect(parseScope('patient/Observation.read')).toMatchObject({
      context: 'patient',
      resourceType: 'Observation',
      version: 1,
    });
  });

  it('reads v2 scopes, with a restriction by query', () => {
    expect(
      parseScope('patient/Observation.rs?category=laboratory'),
    ).toMatchObject({
      context: 'patient',
      resourceType: 'Observation',
      query: 'category=laboratory',
      version: 2,
    });
    expect([...parseScope('system/*.cud')!.permissions]).toEqual([
      'c',
      'u',
      'd',
    ]);
  });

  it('leaves out scopes not on resources, and those not well formed', () => {
    for (const s of [
      'openid',
      'fhirUser',
      'launch/patient',
      'offline_access',
      'patient/Observation.sr', // out of order
      'patient/Observation.rr', // twice
      'patient/Observation.rx', // not a permission
      'patient/Observation.read?category=x', // v1 has no query
      'clinic/Observation.rs', // not a context
      'patient/observation.rs', // not a type
    ])
      expect(parseScope(s)).toBeUndefined();
    expect(
      parseScopes(
        'openid fhirUser launch/patient patient/*.rs user/Encounter.read',
      ).map(s => s.scope),
    ).toEqual(['patient/*.rs', 'user/Encounter.read']);
  });

  it('finds the scopes that grant a permission on a type', () => {
    const scopes = parseScopes([
      'patient/*.rs',
      'patient/Observation.cu',
      'system/Patient.r',
    ]);
    expect(
      grantingScopes(scopes, 'r', 'Observation').map(s => s.scope),
    ).toEqual(['patient/*.rs']);
    expect(
      grantingScopes(scopes, 'c', 'Observation').map(s => s.scope),
    ).toEqual(['patient/Observation.cu']);
    expect(grantingScopes(scopes, 'r', 'Patient').map(s => s.scope)).toEqual([
      'patient/*.rs',
      'system/Patient.r',
    ]);
    expect(
      grantingScopes(scopes, 'r', 'Patient', ['system']).map(s => s.scope),
    ).toEqual(['system/Patient.r']);
    expect(grantingScopes(scopes, 'd', 'Observation')).toEqual([]);
  });
});
