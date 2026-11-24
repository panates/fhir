/*
 * SMART on FHIR authorization (SMART App Launch 2.x): discovery of the
 * server's endpoints, backend services (client credentials with a signed JWT
 * assertion) and app launch (authorization code with PKCE), each giving a
 * token provider for bearerToken().
 *
 * Signing and hashing use Web Crypto (crypto.subtle), so the same code runs
 * in Node 22 and in browsers.
 */
import type { FhirTokenProvider } from './bearer-token.js';
import {
  fhirUserReference,
  type IdTokenClaims,
  verifyIdToken,
} from './id-token.js';

/** What a server's .well-known/smart-configuration says (the parts used here, and the rest) */
export interface SmartConfiguration {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint: string;
  token_endpoint_auth_methods_supported?: string[];
  grant_types_supported?: string[];
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  capabilities?: string[];
  [key: string]: unknown;
}

/** A token response, as the server sent it (the parts used here, and the rest) */
export interface SmartTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
  id_token?: string;
  /** Launch context: the patient, encounter ... the app was launched for */
  patient?: string;
  encounter?: string;
  [key: string]: unknown;
}

/** An error of the authorization server (OAuth's error and error_description) */
export class SmartAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly error?: string,
  ) {
    super(message);
    this.name = 'SmartAuthError';
  }
}

interface FetchOption {
  /** The fetch to use (default: the global one) */
  fetch?: typeof fetch;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s)
    throw new SmartAuthError('Web Crypto (crypto.subtle) is not available');
  return s;
};

const base64url = (bytes: Uint8Array | ArrayBuffer): string => {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const base64urlJson = (v: unknown) =>
  base64url(new TextEncoder().encode(JSON.stringify(v)));

/** Random bytes as base64url: state, PKCE verifiers, JWT ids */
const random = (bytes = 32) =>
  base64url(crypto.getRandomValues(new Uint8Array(bytes)));

/**
 * Token endpoints receive secrets and signed assertions: only over https
 * (or to this machine, for development)
 */
function checkEndpoint(url: string, what: string): string {
  const u = new URL(url);
  const local =
    u.hostname === 'localhost' ||
    u.hostname === '127.0.0.1' ||
    u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local))
    throw new SmartAuthError(`The ${what} ${url} is not https`);
  return url;
}

/** POST a form to a token endpoint; the token response, or a SmartAuthError */
async function tokenRequest(
  endpoint: string,
  form: Record<string, string | undefined>,
  options: FetchOption & { headers?: Record<string, string> },
): Promise<SmartTokenResponse> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form))
    if (v !== undefined) body.set(k, v);
  const res = await (options.fetch ?? fetch)(
    checkEndpoint(endpoint, 'token endpoint'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        ...options.headers,
      },
      body,
    },
  );
  const json: any = await res.json().catch(() => undefined);
  if (!res.ok || typeof json?.access_token !== 'string') {
    const error = typeof json?.error === 'string' ? json.error : undefined;
    const detail = [
      error,
      typeof json?.error_description === 'string'
        ? json.error_description
        : undefined,
    ]
      .filter(Boolean)
      .join(': ');
    throw new SmartAuthError(
      `Token request failed: ${res.status}${detail ? ` (${detail})` : ''}`,
      res.status,
      error,
    );
  }
  return json;
}

/** A token kept until shortly before it expires */
class TokenCache {
  private token?: string;
  private expiresAt = 0;
  private pending?: Promise<string>;

  constructor(
    private readonly fetchToken: () => Promise<SmartTokenResponse>,
    private readonly onToken?: (t: SmartTokenResponse) => void,
  ) {}

  /** The cached token, or a new one; `refresh` forces a new one */
  get(refresh: boolean): Promise<string> {
    if (!refresh && this.token && Date.now() < this.expiresAt)
      return Promise.resolve(this.token);
    this.pending ??= this.fetchToken()
      .then(t => {
        this.token = t.access_token;
        // 30 seconds early, so a token does not expire on its way
        this.expiresAt =
          Date.now() + Math.max(0, (t.expires_in ?? 300) - 30) * 1000;
        this.onToken?.(t);
        return t.access_token;
      })
      .finally(() => (this.pending = undefined));
    return this.pending;
  }
}

/* ------------------------------------------------------------------ */
/* Discovery                                                          */
/* ------------------------------------------------------------------ */

/** Reads [base]/.well-known/smart-configuration */
export async function discoverSmart(
  baseUrl: string | URL,
  options: FetchOption = {},
): Promise<SmartConfiguration> {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/.well-known/smart-configuration`;
  const res = await (options.fetch ?? fetch)(url, {
    headers: { Accept: 'application/json' },
  });
  const json: any = await res.json().catch(() => undefined);
  if (!res.ok || typeof json?.token_endpoint !== 'string')
    throw new SmartAuthError(
      `${url}: ${res.status}, no SMART configuration`,
      res.status,
    );
  return json;
}

/* ------------------------------------------------------------------ */
/* Backend services                                                   */
/* ------------------------------------------------------------------ */

export type SmartSigningAlgorithm = 'RS384' | 'ES384';

export interface SmartBackendServicesOptions extends FetchOption {
  /** The token endpoint (from discoverSmart()) */
  tokenEndpoint: string;
  /** The client id the server registered */
  clientId: string;
  /** The private key the assertion is signed with: a CryptoKey, or a private JWK */
  key: CryptoKey | JsonWebKey;
  /** RS384 or ES384 (the two SMART requires servers to take) */
  alg: SmartSigningAlgorithm;
  /** The key's id in the client's JWK Set */
  kid?: string;
  /** The JWK Set URL the server registered for the client (jku header) */
  jku?: string;
  /** Scopes: 'system/Patient.rs system/Observation.rs' */
  scope: string;
}

const ALGORITHMS: Record<
  SmartSigningAlgorithm,
  { importParams: any; signParams: any }
> = {
  RS384: {
    importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
    signParams: { name: 'RSASSA-PKCS1-v1_5' },
  },
  ES384: {
    importParams: { name: 'ECDSA', namedCurve: 'P-384' },
    // Web Crypto gives ECDSA signatures as r || s, the form JWS takes
    signParams: { name: 'ECDSA', hash: 'SHA-384' },
  },
};

/**
 * SMART Backend Services: a system (no user) gets tokens with the client
 * credentials grant, authenticating with a JWT it signs with its private key.
 *
 * ```ts
 * const config = await discoverSmart(baseUrl);
 * const backend = new SmartBackendServices({ tokenEndpoint: config.token_endpoint, clientId, key, alg: 'ES384', kid, scope: 'system/*.rs' });
 * new FhirClient({ baseUrl, fhir, interceptors: [bearerToken(backend.provider)] });
 * ```
 */
export class SmartBackendServices {
  private readonly cache: TokenCache;
  private key?: Promise<CryptoKey>;

  constructor(readonly options: SmartBackendServicesOptions) {
    checkEndpoint(options.tokenEndpoint, 'token endpoint');
    this.cache = new TokenCache(() => this.requestToken());
  }

  /** The token provider for bearerToken(): cached until it expires, new on refresh */
  readonly provider: FhirTokenProvider = refresh => this.cache.get(refresh);

  /** The signed client assertion (a JWT good for 5 minutes, with a new jti) */
  async assertion(): Promise<string> {
    const o = this.options;
    const alg = ALGORITHMS[o.alg];
    if (!alg) throw new SmartAuthError(`${o.alg} is not RS384 or ES384`);
    const key = await (this.key ??= this.importKey());
    const now = Math.floor(Date.now() / 1000);
    const header = {
      alg: o.alg,
      typ: 'JWT',
      ...(o.kid ? { kid: o.kid } : {}),
      ...(o.jku ? { jku: o.jku } : {}),
    };
    const payload = {
      iss: o.clientId,
      sub: o.clientId,
      aud: o.tokenEndpoint,
      exp: now + 300,
      jti: random(16),
    };
    const input = `${base64urlJson(header)}.${base64urlJson(payload)}`;
    const signature = await subtle().sign(
      alg.signParams,
      key,
      new TextEncoder().encode(input),
    );
    return `${input}.${base64url(signature)}`;
  }

  private async importKey(): Promise<CryptoKey> {
    const { key, alg } = this.options;
    if (!(key as CryptoKey).type) {
      const jwk = key as JsonWebKey;
      if (!jwk.d)
        throw new SmartAuthError(
          'The key is a public JWK: a private key signs the assertion',
        );
      return subtle().importKey(
        'jwk',
        jwk,
        ALGORITHMS[alg].importParams,
        false,
        ['sign'],
      );
    }
    if ((key as CryptoKey).type !== 'private')
      throw new SmartAuthError('The key is not a private key');
    return key as CryptoKey;
  }

  private async requestToken(): Promise<SmartTokenResponse> {
    const o = this.options;
    return tokenRequest(
      o.tokenEndpoint,
      {
        grant_type: 'client_credentials',
        scope: o.scope,
        client_assertion_type:
          'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: await this.assertion(),
      },
      o,
    );
  }
}

/* ------------------------------------------------------------------ */
/* App launch                                                         */
/* ------------------------------------------------------------------ */

export interface SmartAppLaunchOptions extends FetchOption {
  /** From discoverSmart() */
  configuration: SmartConfiguration;
  /** The FHIR server's base URL: the aud the token is for */
  fhirBaseUrl: string;
  clientId: string;
  redirectUri: string;
  /** Scopes: 'launch openid fhirUser patient/*.rs offline_access' */
  scope: string;
  /** A confidential client's secret (client_secret_basic); a public client has none */
  clientSecret?: string;
  /**
   * The issuer of id_tokens (default: the configuration's `issuer`); an
   * id_token is verified against its keys
   */
  issuer?: string;
  /** Verify id_tokens (default true); false only for a server known not to sign them */
  verifyIdToken?: boolean;
}

/**
 * What authorize() made and callback() needs: keep it in the session (not in
 * the URL) between the redirect and the callback
 */
export interface SmartPendingAuthorization {
  state: string;
  codeVerifier: string;
  /** Sent when the scope has openid: the id_token must carry it back */
  nonce?: string;
}

/** The user an id_token names */
export interface SmartUser {
  /** The verified claims of the id_token */
  claims: IdTokenClaims;
  /** The FHIR resource of the user, as the token says it */
  fhirUser?: string;
  /** That resource as type and id on this FHIR server (to read it); undefined when it is elsewhere */
  reference?: { type: string; id: string };
}

/** What the server granted: tokens and the launch context */
export interface SmartSession {
  accessToken: string;
  /** When the access token expires (ms since the epoch); undefined when not said */
  expiresAt?: number;
  refreshToken?: string;
  scope?: string;
  idToken?: string;
  patient?: string;
  encounter?: string;
  /** The user, from the verified id_token (scope openid) */
  user?: SmartUser;
  /** The whole token response */
  response: SmartTokenResponse;
}

const toSession = (
  t: SmartTokenResponse,
  previous?: SmartSession,
): SmartSession => ({
  accessToken: t.access_token,
  expiresAt:
    t.expires_in !== undefined ? Date.now() + t.expires_in * 1000 : undefined,
  // a refresh may not send a new refresh token: the old one stays good
  refreshToken: t.refresh_token ?? previous?.refreshToken,
  scope: t.scope ?? previous?.scope,
  idToken: t.id_token ?? previous?.idToken,
  patient: t.patient ?? previous?.patient,
  encounter: t.encounter ?? previous?.encounter,
  user: previous?.user,
  response: t,
});

/**
 * SMART App Launch: the authorization code grant with PKCE, for a
 * standalone launch or an EHR launch (`launch`).
 *
 * ```ts
 * const app = new SmartAppLaunch({ configuration, fhirBaseUrl, clientId, redirectUri, scope });
 * const { url, pending } = await app.authorize({ launch });   // keep `pending` in the session; redirect to url
 * const session = await app.callback(location.href, pending); // on the redirect back
 * new FhirClient({ baseUrl: fhirBaseUrl, fhir, interceptors: [bearerToken(app.provider(session))] });
 * ```
 */
export class SmartAppLaunch {
  constructor(readonly options: SmartAppLaunchOptions) {
    if (!options.configuration.authorization_endpoint)
      throw new SmartAuthError(
        'The server has no authorization_endpoint: it does not support app launch',
      );
    checkEndpoint(options.configuration.token_endpoint, 'token endpoint');
    const methods = options.configuration.code_challenge_methods_supported;
    if (methods && !methods.includes('S256'))
      throw new SmartAuthError('The server does not take PKCE with S256');
  }

  /**
   * The URL to send the user to, and what the callback will need. `launch`:
   * the launch parameter of an EHR launch.
   */
  async authorize(
    options: { launch?: string } = {},
  ): Promise<{ url: string; pending: SmartPendingAuthorization }> {
    const o = this.options;
    const state = random(16);
    const codeVerifier = random(32);
    const nonce = /(^|\s)openid(\s|$)/.test(o.scope) ? random(16) : undefined;
    const challenge = base64url(
      await subtle().digest('SHA-256', new TextEncoder().encode(codeVerifier)),
    );
    const url = new URL(o.configuration.authorization_endpoint!);
    const params: Record<string, string | undefined> = {
      response_type: 'code',
      client_id: o.clientId,
      redirect_uri: o.redirectUri,
      scope: o.scope,
      state,
      aud: o.fhirBaseUrl,
      launch: options.launch,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      nonce,
    };
    for (const [k, v] of Object.entries(params))
      if (v !== undefined) url.searchParams.set(k, v);
    return {
      url: url.toString(),
      pending: { state, codeVerifier, ...(nonce ? { nonce } : {}) },
    };
  }

  /**
   * The redirect back: checks its state against the pending one, and trades
   * the code for tokens
   */
  async callback(
    callbackUrl: string | URL,
    pending: SmartPendingAuthorization,
  ): Promise<SmartSession> {
    const params = new URL(String(callbackUrl)).searchParams;
    const error = params.get('error');
    if (error)
      throw new SmartAuthError(
        `Authorization refused: ${error}${params.get('error_description') ? ` (${params.get('error_description')})` : ''}`,
        undefined,
        error,
      );
    if (!pending?.state || params.get('state') !== pending.state)
      throw new SmartAuthError(
        'The state of the callback is not the one sent: the request may be forged',
      );
    const code = params.get('code');
    if (!code) throw new SmartAuthError('The callback has no code');
    const t = await this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.options.redirectUri,
      code_verifier: pending.codeVerifier,
    });
    const session = toSession(t);
    if (t.id_token) session.user = await this.user(t.id_token, pending.nonce);
    return session;
  }

  /** The user of an id_token, verified (unless verifyIdToken is false) */
  private async user(
    idToken: string,
    nonce?: string,
  ): Promise<SmartUser | undefined> {
    const o = this.options;
    if (o.verifyIdToken === false) return;
    const issuer = o.issuer ?? o.configuration.issuer;
    if (!issuer)
      throw new SmartAuthError(
        'An id_token came, but the issuer to verify it with is not known: give `issuer`',
      );
    const claims = await verifyIdToken(idToken, {
      issuer,
      clientId: o.clientId,
      nonce,
      fetch: o.fetch,
    });
    const fhirUser =
      typeof claims.fhirUser === 'string' ? claims.fhirUser : undefined;
    return {
      claims,
      fhirUser,
      reference: fhirUser
        ? fhirUserReference(fhirUser, o.fhirBaseUrl)
        : undefined,
    };
  }

  /** A new access token with the session's refresh token; the updated session */
  async refresh(session: SmartSession): Promise<SmartSession> {
    if (!session.refreshToken)
      throw new SmartAuthError(
        'The session has no refresh token (ask for offline_access or online_access)',
      );
    const t = await this.token({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
    });
    const next = toSession(t, session);
    // a refresh may bring a new id_token: verified too (it carries no nonce)
    if (t.id_token) next.user = (await this.user(t.id_token)) ?? session.user;
    return next;
  }

  /**
   * A token provider for bearerToken() over a session: its access token, a
   * refreshed one when it expires or the server refuses it. `onSession`
   * hears of each new session (to store it).
   */
  provider(
    session: SmartSession,
    onSession?: (s: SmartSession) => void,
  ): FhirTokenProvider {
    let current = session;
    let pending: Promise<string> | undefined;
    return refresh => {
      const expired =
        current.expiresAt !== undefined &&
        Date.now() > current.expiresAt - 30_000;
      if (!refresh && !expired) return current.accessToken;
      pending ??= this.refresh(current)
        .then(s => {
          current = s;
          onSession?.(s);
          return s.accessToken;
        })
        .finally(() => (pending = undefined));
      return pending;
    };
  }

  private token(form: Record<string, string>): Promise<SmartTokenResponse> {
    const o = this.options;
    const headers: Record<string, string> = {};
    if (o.clientSecret)
      headers.Authorization = `Basic ${btoa(`${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`)}`;
    // a public client names itself in the form
    return tokenRequest(
      o.configuration.token_endpoint,
      o.clientSecret ? form : { ...form, client_id: o.clientId },
      { ...o, headers },
    );
  }
}
