/*
 * OpenID Connect id_token verification, for SMART App Launch (scope
 * `openid fhirUser`): the token's signature against the issuer's published
 * keys (its openid-configuration's jwks_uri), and its claims (iss, aud, exp,
 * iat, nonce). Web Crypto, as the rest of the SMART code.
 */

/** The claims of an id_token (those checked and used here, and the rest) */
export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  /** SMART: the FHIR resource of the user (Practitioner/1, Patient/2 ...), absolute or relative */
  fhirUser?: string;
  [key: string]: unknown;
}

export interface VerifyIdTokenOptions {
  /** The issuer the token must come from (the SMART configuration's `issuer`) */
  issuer: string;
  /** The client the token must be for (in `aud`) */
  clientId: string;
  /** The nonce sent with the authorization request, when one was sent */
  nonce?: string;
  /** Seconds of clock difference allowed for exp and iat (default 60) */
  clockSkew?: number;
  fetch?: typeof fetch;
}

/** An id_token that does not verify */
export class IdTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdTokenError';
  }
}

/** The algorithms taken: RS256 (which SMART requires), RS384, ES256, ES384 */
const ALGORITHMS: Record<string, { import: any; verify: any }> = {
  RS256: {
    import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    verify: { name: 'RSASSA-PKCS1-v1_5' },
  },
  RS384: {
    import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
    verify: { name: 'RSASSA-PKCS1-v1_5' },
  },
  ES256: {
    import: { name: 'ECDSA', namedCurve: 'P-256' },
    verify: { name: 'ECDSA', hash: 'SHA-256' },
  },
  ES384: {
    import: { name: 'ECDSA', namedCurve: 'P-384' },
    verify: { name: 'ECDSA', hash: 'SHA-384' },
  },
};

const b64urlBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(
    s.replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - (s.length % 4)) % 4),
  );
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};
const b64urlJson = (s: string): any =>
  JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

/** https only, but for this machine (development) */
function checkUrl(url: string, what: string): string {
  const u = new URL(url);
  const local =
    u.hostname === 'localhost' ||
    u.hostname === '127.0.0.1' ||
    u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local))
    throw new IdTokenError(`The ${what} ${url} is not https`);
  return url;
}

async function getJson(
  url: string,
  what: string,
  f: typeof fetch,
): Promise<any> {
  const res = await f(checkUrl(url, what), {
    headers: { Accept: 'application/json' },
  });
  const json = await res.json().catch(() => undefined);
  if (!res.ok || !json)
    throw new IdTokenError(`${url}: ${res.status}, no ${what}`);
  return json;
}

/** Each issuer's keys, by kid, kept for an hour; a kid not known reads them again (key rotation) */
const keySets = new Map<string, { keys: JsonWebKey[]; readAt: number }>();
const KEYS_TTL = 3_600_000;

async function keysOf(
  issuer: string,
  f: typeof fetch,
  reload: boolean,
): Promise<JsonWebKey[]> {
  const cached = keySets.get(issuer);
  if (cached && !reload && Date.now() - cached.readAt < KEYS_TTL)
    return cached.keys;
  const config = await getJson(
    `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`,
    'OpenID configuration',
    f,
  );
  if (config.issuer !== undefined && config.issuer !== issuer)
    throw new IdTokenError(
      `The OpenID configuration of ${issuer} names another issuer, ${config.issuer}`,
    );
  if (typeof config.jwks_uri !== 'string')
    throw new IdTokenError(
      `The OpenID configuration of ${issuer} has no jwks_uri`,
    );
  const jwks = await getJson(config.jwks_uri, 'JWK Set', f);
  const keys: JsonWebKey[] = Array.isArray(jwks.keys) ? jwks.keys : [];
  keySets.set(issuer, { keys, readAt: Date.now() });
  return keys;
}

/**
 * Verifies an id_token: its signature with the issuer's key, and that it
 * comes from that issuer, is for this client, has not expired, and carries
 * the nonce sent. Gives its claims; throws IdTokenError otherwise.
 */
export async function verifyIdToken(
  idToken: string,
  options: VerifyIdTokenOptions,
): Promise<IdTokenClaims> {
  const f = options.fetch ?? fetch;
  const parts = idToken.split('.');
  if (parts.length !== 3)
    throw new IdTokenError('The id_token is not a signed JWT');
  let header: any;
  let claims: IdTokenClaims;
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]);
  } catch {
    throw new IdTokenError('The id_token cannot be read');
  }
  // the algorithm comes from a list: never 'none', never one the key was not made for
  const alg = ALGORITHMS[header.alg];
  if (!alg)
    throw new IdTokenError(
      `The id_token is signed ${header.alg}, which is not taken`,
    );

  // the issuer is the one expected: its keys are read from it, not from the token
  if (claims.iss !== options.issuer)
    throw new IdTokenError(
      `The id_token comes from ${claims.iss}, not ${options.issuer}`,
    );

  const pick = (keys: JsonWebKey[]) =>
    keys.find(
      k =>
        (header.kid === undefined || (k as any).kid === header.kid) &&
        (k.alg === undefined || k.alg === header.alg) &&
        k.use !== 'enc',
    );
  let jwk = pick(await keysOf(options.issuer, f, false));
  if (!jwk) jwk = pick(await keysOf(options.issuer, f, true));
  if (!jwk)
    throw new IdTokenError(
      `The issuer has no key ${header.kid ?? ''} for ${header.alg}`.replace(
        '  ',
        ' ',
      ),
    );
  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { ...jwk, key_ops: ['verify'] },
      alg.import,
      false,
      ['verify'],
    );
    valid = await crypto.subtle.verify(
      alg.verify,
      key,
      b64urlBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    valid = false;
  }
  if (!valid)
    throw new IdTokenError('The signature of the id_token is not valid');

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(options.clientId))
    throw new IdTokenError(
      `The id_token is for ${aud.join(', ')}, not ${options.clientId}`,
    );
  if (aud.length > 1 && (claims as any).azp !== options.clientId)
    throw new IdTokenError(
      'The id_token has several audiences and is not authorized for this client (azp)',
    );
  const now = Date.now() / 1000;
  const skew = options.clockSkew ?? 60;
  if (typeof claims.exp !== 'number' || claims.exp + skew < now)
    throw new IdTokenError('The id_token has expired');
  if (typeof claims.iat !== 'number' || claims.iat - skew > now)
    throw new IdTokenError('The id_token was issued in the future');
  if (options.nonce !== undefined && claims.nonce !== options.nonce)
    throw new IdTokenError('The nonce of the id_token is not the one sent');
  return claims;
}

/** A fhirUser claim as a resource type and id, read against the FHIR server's base URL */
export function fhirUserReference(
  fhirUser: string,
  fhirBaseUrl: string,
): { type: string; id: string } | undefined {
  const base = fhirBaseUrl.replace(/\/+$/, '');
  const relative = fhirUser.startsWith(base + '/')
    ? fhirUser.slice(base.length + 1)
    : /^[a-z][a-z0-9+.-]*:/i.test(fhirUser)
      ? undefined
      : fhirUser;
  const m =
    relative && /^([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})$/.exec(relative);
  return m ? { type: m[1], id: m[2] } : undefined;
}
