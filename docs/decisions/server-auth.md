# Authentication and authorization in `@fhirjs/server`

The design of who may call the server and what they may do, before any code. The decisions in
the first section were taken with the user on 2026-11-22; the rest is the proposal they lead to,
open to change until it is built. The server itself is designed in [`server.md`](server.md).

## Decided (2026-11-22)

| Question | Decision | Why |
| -------- | -------- | --- |
| Shape | Two interfaces, one for each question: an **authenticator** finds out who is calling, an **authorizer** decides what they may do. The server ships implementations of both; a user writes others and gives them instead | Authentication differs between deployments (a SMART token, an API key, a certificate a proxy checked, a session) and so do the rules (SMART scopes, a hospital's own roles). Neither should be fixed in the server. |
| Several ways in, and checks in steps | Authenticators given together are alternatives (OR), and one that refuses credentials of its kind stops the chain with 401; more checks on one caller wrap its authenticator (AND), with a helper `checked()` | The user's applications check a JWT and then a session in Redis, so that ending the session refuses the caller at once (example below). That check belongs to JWT callers only, not to integrations with an API key. |
| Tokens | JWT checked with the authorization server's keys (JWKS) by default; token introspection (RFC 7662) as the other built-in authenticator | JWT needs no call per request; introspection sees a revoked token at once and reads opaque tokens. Keycloak gives both. |
| Scopes | SMART v1 and v2 both, v1 read as v2 (`read` is `rs`, `write` is `cud`, `*` is `cruds`), with v2's restrictions by query (`patient/Observation.rs?category=laboratory`) | SMART 2 servers are asked to take v1 tokens; the search the server has applies a restriction as one more criterion. |
| Where the JWT code lives | A small package of its own, `@fhirjs/smart`: JWT verification (JWS with a JWK Set, keys kept and fetched again on rotation) and the parsing of scopes. The client and the server both use it | The client already checks `id_token`s; the server needs the same with key caching. One place for both. |
| Whether stores see the caller | Yes: every store method takes an optional last argument `context: { principal, request }`. Stores written before take no notice of it | A facade over an existing database may apply the database's own rules per row. |
| A resource outside the patient compartment | 404, as for a resource that is not there; 403 when the interaction itself is not allowed | A `patient/` token does not learn that another patient's record exists. |
| Contexts | `system/` and `patient/` in the first step; `user/` through a hook the user writes | `system/` needs nothing but the scope. `patient/` is the patient compartment, which the specification defines. Which records a user may see is the hospital's rule, which the server cannot know. |

## Who is calling: the authenticator

```ts
/** What an authenticator found out about the caller */
interface FhirPrincipal {
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

interface FhirAuthenticator {
  /**
   * The caller of a request. Undefined when the request carries nothing this
   * authenticator reads, so the next one is asked; FhirServerError(401) for
   * credentials it reads and refuses (a bad signature, an expired token).
   */
  authenticate(request: Request): Promise<FhirPrincipal | undefined>;
  /** The WWW-Authenticate header of a 401: 'Bearer realm="fhir"' */
  challenge?: string;
}
```

- **Several authenticators are alternatives (OR):** users with a JWT, or integrations with an API
  key. Each is asked in turn:
  - it returns `undefined` when the request has no credentials of its kind (no Bearer token): the
    next one is asked;
  - it returns a principal: that is the caller, the others are not asked;
  - it reads credentials of its kind and refuses them (a bad signature, an expired token): 401,
    and **the chain stops there**. A request with a bad token never falls through to another way
    in.
- **Checks on one caller are made by wrapping (AND):** an authenticator that calls another and
  then checks more. The helper `checked(authenticator, check)` does it: `check(principal,
  request)` runs after the inner authenticator found a principal, and throws FhirServerError(401)
  to refuse it, or returns the principal (with more claims, if it reads more). The check belongs
  to that authenticator only.
- **Built in:**
  - `JwtAuthenticator`: a Bearer JWT, checked by signature with the keys of the issuer's
    `jwks_uri` (kept, fetched again when a token names a key it does not have, as keys are
    rotated), and by `iss`, `aud` (the server's base URL, or what is given), `exp` and `nbf`, with a
    little clock skew allowed. RS256, RS384, ES256, ES384 and PS256.
  - `IntrospectionAuthenticator`: asks the authorization server whether a token is active, with
    the server's client credentials; keeps the answer for a short time (default 60 s, never past
    the token's `exp`).
- **Written by the user:** an API key read from a header, a client certificate a proxy has checked
  and passed in a header, a session. Anything that turns a request into a `FhirPrincipal`.

### Example: a JWT and a session kept in Redis

The user's own applications check a caller in two steps: the JWT, then, while the token is still
valid, a session kept in Redis. Ending the session in Redis refuses the caller at once, without
waiting for the token to expire; the price is one Redis call per request, which a system of a few
thousand users can pay. On this server:

```ts
const jwt = new JwtAuthenticator({ issuer: 'https://auth.example.org/realms/hbys' });

// 2nd step, for JWT callers only: the session the token belongs to (Keycloak's sid) must be open
const users = checked(jwt, async principal => {
  const sid = principal.claims.sid;
  if (typeof sid !== 'string' || !(await redis.exists(`session:${sid}`)))
    throw new FhirServerError(401, 'The session has ended', 'login');
  return principal;
});

new FhirServer({
  fhir,
  store,
  security: {
    authenticators: [users, apiKeys], // users: JWT and session; integrations: an API key
    authorizer: new SmartAuthorizer(),
  },
});
```

- Redis is asked only after the signature and the expiry passed: forged and expired tokens do not
  reach it. Callers with an API key never reach it.
- The check may add what the session holds (roles) to `principal.claims`, for an authorizer of
  the user's own.
- The check may keep its answer a few seconds in memory to save calls; a session ended is then
  refused that much later.
- Token introspection sees an ended session at once too, but asks the authorization server on
  every request; the Redis check does the same against a faster store the user runs.

## What they may do: the authorizer

```ts
/** What is asked of the server */
interface FhirAccess {
  /** undefined: nobody authenticated (anonymous) */
  principal?: FhirPrincipal;
  interaction:
    | 'read' | 'vread' | 'search' | 'history' | 'create' | 'update' | 'patch' | 'delete'
    | 'validate';
  type?: string;
  id?: string;
}

interface FhirAccessDecision {
  allowed: boolean;
  /** Why not, for the OperationOutcome of a 403 */
  reason?: string;
  /**
   * search, history: criteria every result must also match, in a search URL's
   * form ('patient=Patient/123&category=laboratory'), read strictly
   */
  criteria?: string;
}

interface FhirAuthorizer {
  /** Before the store is asked: may the principal do this at all */
  authorize(access: FhirAccess): Promise<FhirAccessDecision>;
  /**
   * A resource read, or about to be written (and, for an update, patch or
   * delete, the one it replaces): may the principal see or write it. Every
   * resource when not given.
   */
  authorizeResource?(access: FhirAccess, resource: Record<string, any>): Promise<boolean>;
}
```

- **Built in: `SmartAuthorizer`.** It reads the scopes (v1 and v2) and maps each interaction to
  its letter: `r` for read, vread and history, `s` for search, `c` for create, `u` for update and
  patch, `d` for delete; `$validate` stores nothing and needs `r` of the type. Then:
  - `system/`: the scope is enough.
  - `patient/`: the principal's `patient` and the patient compartment. A search gets
    `patient=Patient/<id>` (by the compartment's parameters of the type) as one more criterion; a
    resource read or written must be in the compartment. The compartment's parameters come from
    the `CompartmentDefinition` of the core package, written into the version packages by the
    generator as the search parameters are.
  - `user/`: the scope, then a hook: `userAccess(principal, access, resource)`, which the user
    writes with the hospital's rules.
  - a v2 restriction (`?category=laboratory`) is added to a search's criteria, and checked against
    a resource read or written.
- **Written by the user:** a role-based authorizer, one that asks another service, one that wraps
  `SmartAuthorizer` and adds rules.

## How the server uses them

```ts
new FhirServer({
  fhir,
  store,
  security: {
    authenticators: [new JwtAuthenticator({ issuer: 'https://auth.example.org/realms/hbys' })],
    authorizer: new SmartAuthorizer({ userAccess: (principal, access, resource) => ... }),
    // optional: what /.well-known/smart-configuration gives
    smart: { authorizationEndpoint: '...', tokenEndpoint: '...' },
  },
});
```

- **Without `security`** the server is open, as it is now.
- **Order:** the request is routed; `metadata` and `/.well-known/smart-configuration` need no
  authentication. The authenticators run; with none finding a principal, the answer is 401 with
  the challenge (an option `anonymous: true` passes an undefined principal on instead). The
  authorizer's `authorize()` runs: 403 with its reason when not allowed. Then the store is asked;
  a search with the authorizer's criteria added (AND), a read with the resource checked by
  `authorizeResource()`, a write with the new resource (and the one it replaces) checked before
  the store writes.
- **Statuses:** 401 when nobody is authenticated or the credentials are refused, 403 when the
  scopes do not allow the interaction on the type, 404 for a resource outside what the principal
  may see (it does not tell that the resource exists). History and search leave out what
  `authorizeResource()` refuses.
- **Interceptors** still run around everything, before authentication.
- The `CapabilityStatement` gets `rest.security`: `cors`, the SMART service, and the OAuth
  endpoints as an extension when `smart` is given.


## Built: `@fhirjs/smart` (2026-11-22)

`packages/smart`, no dependency, Web Crypto:

- `verifyJwt(token, { keys, issuer, audience?, algorithms?, clockSkew?, requireIat?, name? })`:
  the algorithm from a list (RS256, RS384, ES256, ES384, PS256 by default; RS512 and PS384 when
  asked; never `none` or HMAC), the issuer (one of several, if given), the key by `kid` and `alg`
  (never one for encryption), the signature, the audience, `exp`, `nbf`, and `iat` when asked. A
  `JwtError` says why, with a `code` (`algorithm`, `issuer`, `key`, `signature`, `audience`,
  `expired`, `not-yet-valid`, `malformed`); `name` puts the token's name in the message.
- `JwksClient({ issuer | jwksUri, cacheTtl?, minRefetchInterval?, fetch? })`: finds the JWK Set
  by the issuer's OpenID configuration (which must name the same issuer) or by its URL, https only
  but for this machine; keeps it an hour; reads it again for a `kid` it does not have, at most
  every 30 s by default; one read for concurrent requests.
- `parseScope()`, `parseScopes()`, `grantingScopes()`: scopes on resources, v1 read as v2
  (`read` as `rs`, `write` as `cud`, `*` as `cruds`), v2's letters in the order c, r, u, d, s,
  v2's restriction by query kept in `query`. Other scopes (`openid`, `launch/patient`) and scopes
  not well formed are left out.
- **The client uses it:** `verifyIdToken()` keeps its options and messages and checks `azp` and
  the nonce itself; its keys are read again at once for an unknown `kid`
  (`minRefetchInterval: 0`), as before. The client's tests pass unchanged.

Tests: `packages/smart/test/smart.spec.ts`, 8, with keys made by Web Crypto and an issuer on
127.0.0.1 that counts the reads of its JWK Set. Control runs: without the signature check, without
the audience check, without the least time between reads, with concurrent reads not shared, and
without the order of v2 letters, a test fails each time. 271 tests before, 279 after.

## Built: the server's authentication and authorization (2026-11-22)

`packages/server`: `security.ts` (`FhirPrincipal`, `FhirAuthenticator`, `FhirAuthorizer`,
`FhirAccess`, `FhirAccessDecision`, `FhirRequestContext`, `checked()`), `authenticators.ts`
(`JwtAuthenticator`, `IntrospectionAuthenticator`, `principalOf()`), and the server's
`security` option. `SmartAuthorizer`, with the compartments, is the next step; until then an
authorizer is the user's own, or none (every authenticated caller may do everything).

Where it differs from the proposal above, and why:

- **`authenticate(request, info)`** takes a second argument, `{ baseUrl }`: `JwtAuthenticator`
  checks `aud` against the server's base URL when no audience is given, and an authenticator
  cannot know that URL from the request alone (the server may be mounted under a path).
- **Search results are not checked one by one** with `authorizeResource()`: the authorizer's
  `criteria` restrict a search, so that `total` and the pages stay right. Conditional
  interactions, which search for at most two, do check what they find, and leave out what the
  caller may not see (a conditional update then creates rather than touches another patient's
  record).
- **History leaves out** the versions the caller may not see, and, when the authorizer checks
  resources, deleted versions too, which have no resource to check.
- **A write outside what the caller may write** answers 403; the resource it would replace, when
  the caller may not see it, 404, as a read.
- **`/.well-known/smart-configuration`** is served only when `smartConfiguration` is given, and
  `metadata` always; both without authentication. The `CapabilityStatement` gets
  `rest.security` with the `SMART-on-FHIR` service, and SMART's `oauth-uris` extension with the
  endpoints of `smartConfiguration`.
- **Statuses:** 401 with every authenticator's challenge (`Bearer realm="fhir", ApiKey`) when
  nobody is authenticated; 401 with `error="invalid_token"` and the reason when a token is refused.
- **Stores get `context`** (`{ principal, request }`) as the last argument of every method.

`JwtAuthenticator`: the issuer (or one of several, whose keys are found by the token's `iss`),
the audience (the server's base URL, or what is given, or `false`), keys by the issuer's OpenID
configuration or a `JwksClient` given; the principal from `sub` (or `client_id`), `scope` (or
`scp`), `patient`, `encounter`, `fhirUser`, `client_id` (or `azp`). `IntrospectionAuthenticator`:
RFC 7662 with the server's client credentials (Basic), https only but for this machine, answers
kept 60 s and never past the token's `exp` (a token not active, 5 s).

Tests: `packages/server/test/security.spec.ts`, 11, with an issuer on 127.0.0.1 (OpenID
configuration, JWK Set, introspection): metadata and the SMART configuration without a token; 401
and its challenges; a JWT then a session check (the user's Redis example, with a set in memory);
an API key for integrations; a refused token that does not fall through to the API key, and does
not reach the session check; an authorizer of the test's own that keeps a patient's token to their
records in search, read, history, writes and conditional updates; 403 with the authorizer's reason;
anonymous callers; introspection with its cache. Control runs: a refused token falling through,
a read not checked, search criteria not added, history not filtered, the resource replaced not
checked, and `checked()` skipping its check, tests fail each time. 279 tests before, 290 after.
