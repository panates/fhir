/*
 * OpenID Connect id_token verification, for SMART App Launch (scope
 * `openid fhirUser`): the token's signature against the issuer's published
 * keys (its openid-configuration's jwks_uri), and its claims (iss, aud, exp,
 * iat, nonce), with the JWT verification of @fhirjs/smart.
 */
import { JwksClient, JwtError, verifyJwt } from '@fhirjs/smart';

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
const ALGORITHMS = ['RS256', 'RS384', 'ES256', 'ES384'];

/**
 * Each issuer's keys (by the fetch used to read them): kept for an hour, read
 * again for a kid the set does not have, at once (key rotation)
 */
const keySets = new WeakMap<typeof fetch, Map<string, JwksClient>>();

function keysOf(issuer: string, f: typeof fetch): JwksClient {
  let byIssuer = keySets.get(f);
  if (!byIssuer) keySets.set(f, (byIssuer = new Map()));
  let keys = byIssuer.get(issuer);
  if (!keys)
    byIssuer.set(
      issuer,
      (keys = new JwksClient({ issuer, fetch: f, minRefetchInterval: 0 })),
    );
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
  let claims: IdTokenClaims;
  try {
    ({ claims } = (await verifyJwt(idToken, {
      keys: keysOf(options.issuer, options.fetch ?? fetch),
      issuer: options.issuer,
      audience: options.clientId,
      algorithms: ALGORITHMS,
      clockSkew: options.clockSkew,
      requireIat: true,
      name: 'id_token',
    })) as { claims: IdTokenClaims });
  } catch (e) {
    if (e instanceof JwtError) throw new IdTokenError(e.message);
    throw e;
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (aud.length > 1 && (claims as any).azp !== options.clientId)
    throw new IdTokenError(
      'The id_token has several audiences and is not authorized for this client (azp)',
    );
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
