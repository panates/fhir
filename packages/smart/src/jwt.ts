/*
 * JWT verification (JWS, compact form) with Web Crypto: the signature with a
 * key of the issuer's JWK Set, then the registered claims (iss, aud, exp,
 * nbf, iat). For a SMART server's access tokens and a SMART app's
 * id_tokens.
 */
import type { JwksClient } from './jwks.js';
import { JwtError } from './jwt-error.js';

export interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
  [key: string]: unknown;
}

/** The claims of a JWT: the registered ones, and the rest */
export interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  [key: string]: unknown;
}

export interface VerifyJwtOptions {
  /** Where the issuer's keys come from */
  keys: JwksClient;
  /** The issuer the token must come from; one of them, when several */
  issuer: string | readonly string[];
  /** The audience the token must be for (one of its aud); not checked when not given */
  audience?: string | readonly string[];
  /** The algorithms taken (default RS256, RS384, ES256, ES384, PS256) */
  algorithms?: readonly string[];
  /** Seconds of clock difference allowed for exp, nbf and iat (default 60) */
  clockSkew?: number;
  /** iat is required and must not be in the future (an id_token) */
  requireIat?: boolean;
  /** What the token is called in messages ('id_token', 'access token'; default 'token') */
  name?: string;
}

/** The algorithms of Web Crypto a JWS may be signed with */
const ALGORITHMS: Record<string, { import: any; verify: any }> = {
  RS256: {
    import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    verify: { name: 'RSASSA-PKCS1-v1_5' },
  },
  RS384: {
    import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
    verify: { name: 'RSASSA-PKCS1-v1_5' },
  },
  RS512: {
    import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
    verify: { name: 'RSASSA-PKCS1-v1_5' },
  },
  PS256: {
    import: { name: 'RSA-PSS', hash: 'SHA-256' },
    verify: { name: 'RSA-PSS', saltLength: 32 },
  },
  PS384: {
    import: { name: 'RSA-PSS', hash: 'SHA-384' },
    verify: { name: 'RSA-PSS', saltLength: 48 },
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

const DEFAULT_ALGORITHMS = ['RS256', 'RS384', 'ES256', 'ES384', 'PS256'];

const b64urlBytes = (s: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const bin = atob(
    s.replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - (s.length % 4)) % 4),
  );
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};
const b64urlJson = (s: string): any =>
  JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

/** A JWT's parts, read but not verified */
export function decodeJwt(
  token: string,
  name = 'token',
): { header: JwtHeader; claims: JwtClaims; signed: string; signature: string } {
  const parts = token.split('.');
  if (parts.length !== 3)
    throw new JwtError(`The ${name} is not a signed JWT`, 'malformed');
  let header: JwtHeader;
  let claims: JwtClaims;
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]);
  } catch {
    throw new JwtError(`The ${name} cannot be read`, 'malformed');
  }
  if (
    !header ||
    typeof header !== 'object' ||
    !claims ||
    typeof claims !== 'object'
  )
    throw new JwtError(`The ${name} cannot be read`, 'malformed');
  return {
    header,
    claims,
    signed: `${parts[0]}.${parts[1]}`,
    signature: parts[2],
  };
}

/**
 * Verifies a JWT: its algorithm is one taken, it comes from the issuer
 * expected, it is signed with a key of that issuer, it is for the audience
 * (when given), and it is within its time (exp, nbf, iat). Gives its header
 * and claims; throws JwtError otherwise.
 */
export async function verifyJwt(
  token: string,
  options: VerifyJwtOptions,
): Promise<{ header: JwtHeader; claims: JwtClaims }> {
  const name = options.name ?? 'token';
  const { header, claims, signed, signature } = decodeJwt(token, name);

  // the algorithm comes from a list: never 'none', never one the key was not made for
  const taken = options.algorithms ?? DEFAULT_ALGORITHMS;
  const alg = taken.includes(header.alg) ? ALGORITHMS[header.alg] : undefined;
  if (!alg)
    throw new JwtError(
      `The ${name} is signed ${header.alg}, which is not taken`,
      'algorithm',
    );

  // the issuer is one expected: its keys are read from it, not from the token
  const issuers =
    typeof options.issuer === 'string' ? [options.issuer] : options.issuer;
  if (typeof claims.iss !== 'string' || !issuers.includes(claims.iss))
    throw new JwtError(
      `The ${name} comes from ${claims.iss}, not ${issuers.join(' or ')}`,
      'issuer',
    );

  const jwk = await options.keys.keyFor({ kid: header.kid, alg: header.alg });
  if (!jwk)
    throw new JwtError(
      `The issuer has no key ${header.kid ?? ''} for ${header.alg}`.replace(
        '  ',
        ' ',
      ),
      'key',
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
      b64urlBytes(signature),
      new TextEncoder().encode(signed),
    );
  } catch {
    valid = false;
  }
  if (!valid)
    throw new JwtError(
      `The signature of the ${name} is not valid`,
      'signature',
    );

  if (options.audience !== undefined) {
    const expected =
      typeof options.audience === 'string'
        ? [options.audience]
        : options.audience;
    const aud = Array.isArray(claims.aud)
      ? claims.aud
      : claims.aud === undefined
        ? []
        : [claims.aud];
    if (!aud.some(a => expected.includes(a)))
      throw new JwtError(
        `The ${name} is for ${aud.join(', ') || 'no audience'}, not ${expected.join(' or ')}`,
        'audience',
      );
  }
  const now = Date.now() / 1000;
  const skew = options.clockSkew ?? 60;
  if (typeof claims.exp !== 'number' || claims.exp + skew < now)
    throw new JwtError(`The ${name} has expired`, 'expired');
  if (
    claims.nbf !== undefined &&
    (typeof claims.nbf !== 'number' || claims.nbf - skew > now)
  )
    throw new JwtError(`The ${name} is not valid yet`, 'not-yet-valid');
  if (
    options.requireIat &&
    (typeof claims.iat !== 'number' || claims.iat - skew > now)
  )
    throw new JwtError(`The ${name} was issued in the future`, 'not-yet-valid');
  return { header, claims };
}
