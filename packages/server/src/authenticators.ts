import { checkHttps, JwksClient, JwtError, verifyJwt } from '@fhirjs/smart';
import {
  bearerTokenOf,
  type FhirAuthenticationInfo,
  type FhirAuthenticator,
  type FhirPrincipal,
  invalidToken,
} from './security.js';

export interface JwtAuthenticatorOptions {
  /** The issuer of the tokens (the authorization server); one of them, when several */
  issuer: string | readonly string[];
  /**
   * The audience the tokens must be for: the server's base URL when not
   * given. false takes any audience (an authorization server that sets none
   * the server can expect).
   */
  audience?: string | readonly string[] | false;
  /** The keys of an issuer, when they are not found by its OpenID configuration */
  keys?: JwksClient;
  /** The algorithms taken (default RS256, RS384, ES256, ES384, PS256) */
  algorithms?: readonly string[];
  /** Seconds of clock difference allowed (default 60) */
  clockSkew?: number;
  /** The realm of the WWW-Authenticate challenge (default 'fhir') */
  realm?: string;
  fetch?: typeof fetch;
}

/**
 * A Bearer JWT, verified with the issuer's keys (JWKS): the caller is its
 * subject, with the scopes of its `scope` (or `scp`) claim and the SMART
 * context of its claims (patient, encounter, fhirUser).
 */
export class JwtAuthenticator implements FhirAuthenticator {
  readonly challenge: string;
  private readonly _keys = new Map<string, JwksClient>();

  constructor(readonly options: JwtAuthenticatorOptions) {
    this.challenge = `Bearer realm="${options.realm ?? 'fhir'}"`;
  }

  async authenticate(
    request: Request,
    info: FhirAuthenticationInfo,
  ): Promise<FhirPrincipal | undefined> {
    const token = bearerTokenOf(request);
    if (!token) return;
    const issuers =
      typeof this.options.issuer === 'string'
        ? [this.options.issuer]
        : this.options.issuer;
    const audience =
      this.options.audience === false
        ? undefined
        : (this.options.audience ?? info.baseUrl);
    try {
      // the keys of the issuer the token names, when it is one expected
      const iss = unverifiedIssuer(token);
      const issuer = iss && issuers.includes(iss) ? iss : issuers[0];
      const { claims } = await verifyJwt(token, {
        keys: this._keysOf(issuer),
        issuer: issuers,
        audience,
        algorithms: this.options.algorithms,
        clockSkew: this.options.clockSkew,
        name: 'access token',
      });
      return principalOf(claims, 'jwt');
    } catch (e) {
      if (e instanceof JwtError) throw invalidToken(this.challenge, e.message);
      throw e;
    }
  }

  private _keysOf(issuer: string): JwksClient {
    if (this.options.keys) return this.options.keys;
    let keys = this._keys.get(issuer);
    if (!keys)
      this._keys.set(
        issuer,
        (keys = new JwksClient({ issuer, fetch: this.options.fetch })),
      );
    return keys;
  }
}

/** The iss of a token, read without verifying it: which issuer's keys to verify it with */
function unverifiedIssuer(token: string): string | undefined {
  try {
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString(),
    );
    return typeof claims?.iss === 'string' ? claims.iss : undefined;
  } catch {
    return;
  }
}

export interface IntrospectionAuthenticatorOptions {
  /** The authorization server's introspection endpoint (RFC 7662) */
  endpoint: string;
  /** The server's own client at the authorization server */
  clientId: string;
  clientSecret: string;
  /** How long an answer is kept, in milliseconds (default 60 s; never past the token's exp) */
  cacheTtl?: number;
  /** The realm of the WWW-Authenticate challenge (default 'fhir') */
  realm?: string;
  fetch?: typeof fetch;
}

/**
 * A Bearer token of any form, asked about at the authorization server
 * (RFC 7662): the caller of an active token; 401 for one not active. The
 * answers are kept a short time.
 */
export class IntrospectionAuthenticator implements FhirAuthenticator {
  readonly challenge: string;
  private readonly _cache = new Map<
    string,
    { principal?: FhirPrincipal; until: number }
  >();

  constructor(readonly options: IntrospectionAuthenticatorOptions) {
    checkHttps(options.endpoint, 'introspection endpoint');
    this.challenge = `Bearer realm="${options.realm ?? 'fhir'}"`;
  }

  async authenticate(request: Request): Promise<FhirPrincipal | undefined> {
    const token = bearerTokenOf(request);
    if (!token) return;
    const now = Date.now();
    let entry = this._cache.get(token);
    if (!entry || entry.until <= now) {
      entry = await this._ask(token, now);
      if (this._cache.size >= 10_000)
        for (const [k, v] of this._cache)
          if (v.until <= now) this._cache.delete(k);
      this._cache.set(token, entry);
    }
    if (!entry.principal)
      throw invalidToken(this.challenge, 'The access token is not active');
    return entry.principal;
  }

  private async _ask(
    token: string,
    now: number,
  ): Promise<{ principal?: FhirPrincipal; until: number }> {
    const f = this.options.fetch ?? fetch;
    const basic = Buffer.from(
      `${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(this.options.clientSecret)}`,
    ).toString('base64');
    const res = await f(this.options.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({ token, token_type_hint: 'access_token' }),
    });
    const json: any = await res.json().catch(() => undefined);
    if (!res.ok || !json || typeof json !== 'object')
      throw new Error(
        `Token introspection at ${this.options.endpoint}: ${res.status}`,
      );
    const ttl = this.options.cacheTtl ?? 60_000;
    let until = now + ttl;
    if (typeof json.exp === 'number') until = Math.min(until, json.exp * 1000);
    if (
      json.active !== true ||
      (typeof json.exp === 'number' && json.exp * 1000 <= now)
    )
      return { until: now + Math.min(ttl, 5_000) };
    return { principal: principalOf(json, 'introspection'), until };
  }
}

/** A principal from a token's claims (or an introspection answer) */
export function principalOf(
  claims: Record<string, unknown>,
  method: string,
): FhirPrincipal {
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const scopes =
    typeof claims.scope === 'string'
      ? claims.scope.split(/\s+/).filter(Boolean)
      : Array.isArray(claims.scp)
        ? claims.scp.filter((s): s is string => typeof s === 'string')
        : typeof claims.scp === 'string'
          ? claims.scp.split(/\s+/).filter(Boolean)
          : [];
  const clientId = str(claims.client_id) ?? str(claims.azp);
  const p: FhirPrincipal = {
    subject: str(claims.sub) ?? clientId ?? 'unknown',
    method,
    scopes,
    claims,
  };
  if (str(claims.patient)) p.patient = str(claims.patient);
  if (str(claims.encounter)) p.encounter = str(claims.encounter);
  if (str(claims.fhirUser)) p.fhirUser = str(claims.fhirUser);
  if (clientId) p.clientId = clientId;
  return p;
}
