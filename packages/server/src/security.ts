/*
 * Who may call the server, and what they may do: an authenticator finds out
 * who is calling, an authorizer decides what they may do. Both are
 * interfaces; the server ships implementations, and a user writes others.
 * Design: docs/decisions/server-auth.md.
 */
import { FhirServerError } from './fhir-server-error.js';

/** What an authenticator found out about the caller */
export interface FhirPrincipal {
  /** The caller: a token's sub, an API key's name */
  subject: string;
  /** How it was found: 'jwt', 'introspection', 'api-key' ... */
  method: string;
  /** The scopes granted, as written */
  scopes: readonly string[];
  /** The SMART launch context, when there is one */
  patient?: string;
  encounter?: string;
  /** fhirUser: 'Practitioner/123' */
  fhirUser?: string;
  clientId?: string;
  /** Every claim, for an authorizer of your own */
  claims: Readonly<Record<string, unknown>>;
}

/** What the server tells an authenticator of the request it is in */
export interface FhirAuthenticationInfo {
  /** The server's base URL: 'https://host/fhir', the audience of its tokens */
  baseUrl: string;
}

/** Finds out who is calling */
export interface FhirAuthenticator {
  /**
   * The caller of a request. Undefined when the request carries nothing this
   * authenticator reads, so the next one is asked; FhirServerError(401) for
   * credentials it reads and refuses (a bad signature, an expired token),
   * which stops the chain.
   */
  authenticate(
    request: Request,
    info: FhirAuthenticationInfo,
  ): Promise<FhirPrincipal | undefined>;
  /** The WWW-Authenticate challenge of a 401: 'Bearer realm="fhir"' */
  challenge?: string;
}

/** The interactions an authorizer decides on */
export type FhirInteraction =
  | 'read'
  | 'vread'
  | 'search'
  | 'history'
  | 'create'
  | 'update'
  | 'patch'
  | 'delete'
  | 'validate';

/** What is asked of the server */
export interface FhirAccess {
  /** undefined: nobody authenticated (with anonymous: true) */
  principal?: FhirPrincipal;
  interaction: FhirInteraction;
  /** The resource type; undefined for the history of the whole server */
  type?: string;
  id?: string;
}

export interface FhirAccessDecision {
  allowed: boolean;
  /** Why not, for the OperationOutcome of a 403 */
  reason?: string;
  /**
   * search: criteria every result must also match, in a search URL's form
   * ('patient=Patient/123&category=laboratory'), read strictly
   */
  criteria?: string;
}

/** Decides what a principal may do */
export interface FhirAuthorizer {
  /** Before the store is asked: may the principal do this at all */
  authorize(access: FhirAccess): Promise<FhirAccessDecision>;
  /**
   * A resource read, or about to be written (and, for an update, patch or
   * delete, the one it replaces): may the principal see or write it. Every
   * resource when not given. Not asked for the results of a search, which
   * `criteria` restrict, so that totals and pages stay right.
   */
  authorizeResource?(
    access: FhirAccess,
    resource: Record<string, any>,
  ): Promise<boolean>;
}

/** The security of a server */
export interface FhirSecurityOptions {
  /** Ways in, asked in turn (OR); the first that finds a principal is the caller */
  authenticators: readonly FhirAuthenticator[];
  /** What callers may do; anything when not given */
  authorizer?: FhirAuthorizer;
  /** Requests nobody is authenticated for go on (to the authorizer) instead of a 401 */
  anonymous?: boolean;
  /**
   * What GET /.well-known/smart-configuration gives: the authorization
   * server's endpoints and capabilities (authorization_endpoint,
   * token_endpoint, capabilities ...). Not served when not given.
   */
  smartConfiguration?: Record<string, unknown>;
}

/** What a store is told of the request it serves */
export interface FhirRequestContext {
  /** The caller; undefined on a server without security, or for an anonymous caller */
  principal?: FhirPrincipal;
  request: Request;
}

/**
 * An authenticator with more checks on the callers it finds (AND): `check`
 * runs after `inner` found a principal, and throws FhirServerError(401) to
 * refuse it, or gives it back (with more claims, if it reads more). Requests
 * `inner` does not read go on to the next authenticator, unchecked.
 *
 * ```ts
 * checked(jwt, async principal => {
 *   if (!(await redis.exists(`session:${principal.claims.sid}`)))
 *     throw new FhirServerError(401, 'The session has ended', 'login');
 * });
 * ```
 */
export function checked(
  inner: FhirAuthenticator,
  check: (
    principal: FhirPrincipal,
    request: Request,
  ) => FhirPrincipal | void | Promise<FhirPrincipal | void>,
): FhirAuthenticator {
  return {
    challenge: inner.challenge,
    async authenticate(request, info) {
      const principal = await inner.authenticate(request, info);
      if (!principal) return;
      return (await check(principal, request)) ?? principal;
    },
  };
}

/** The Bearer token of a request; undefined when it has none */
export function bearerTokenOf(request: Request): string | undefined {
  const h = request.headers.get('Authorization');
  const m = h ? /^Bearer\s+(\S+)\s*$/i.exec(h) : null;
  return m?.[1];
}

/** A 401 for a token refused, with its WWW-Authenticate */
export function invalidToken(
  challenge: string,
  message: string,
): FhirServerError {
  const e = new FhirServerError(401, message, 'login');
  e.headers = {
    'WWW-Authenticate': `${challenge}, error="invalid_token", error_description="${message.replace(/["\\]/g, "'")}"`,
  };
  return e;
}
