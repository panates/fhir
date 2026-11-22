/*
 * SMART on FHIR scopes on resources: v1 (patient/Observation.read) and v2
 * (patient/Observation.rs, with a restriction by query). A v1 scope is read
 * as the v2 scope it stands for.
 */

/** Whose data: the patient in context, what the user may see, or any (a system) */
export type SmartContext = 'patient' | 'user' | 'system';

/** create, read, update, delete, search */
export type SmartPermission = 'c' | 'r' | 'u' | 'd' | 's';

/** A scope on resources, parsed */
export interface SmartScope {
  /** As written: 'patient/Observation.rs?category=laboratory' */
  scope: string;
  context: SmartContext;
  /** A resource type, or '*' for every type */
  resourceType: string;
  permissions: ReadonlySet<SmartPermission>;
  /**
   * v2: the query the scope is restricted to ('category=laboratory'),
   * without '?'. A resource is in the scope when it matches it as a search.
   */
  query?: string;
  version: 1 | 2;
}

const CONTEXTS = new Set(['patient', 'user', 'system']);
/** v1 permissions as v2's */
const V1: Record<string, string> = { read: 'rs', write: 'cud', '*': 'cruds' };
const ORDER = 'cruds';

/**
 * A scope on resources; undefined for any other scope (openid, fhirUser,
 * launch/patient, offline_access) and for one that is not well formed
 * (v2 letters out of the order c, r, u, d, s).
 */
export function parseScope(scope: string): SmartScope | undefined {
  const m =
    /^(patient|user|system)\/([A-Z][A-Za-z]*|\*)\.([^?]+)(?:\?(.*))?$/.exec(
      scope,
    );
  if (!m || !CONTEXTS.has(m[1])) return;
  const [, context, resourceType, perms, query] = m;
  let letters: string;
  let version: 1 | 2;
  if (Object.hasOwn(V1, perms)) {
    if (query !== undefined) return; // v1 has no query
    letters = V1[perms];
    version = 1;
  } else {
    // v2: some of c, r, u, d, s, each once, in that order
    let at = -1;
    for (const c of perms) {
      const i = ORDER.indexOf(c);
      if (i <= at) return;
      at = i;
    }
    letters = perms;
    version = 2;
  }
  const s: SmartScope = {
    scope,
    context: context as SmartContext,
    resourceType,
    permissions: new Set([...letters] as SmartPermission[]),
    version,
  };
  if (query) s.query = query;
  return s;
}

/** The scopes on resources of a scope string ('openid patient/*.rs') or list; the others left out */
export function parseScopes(scopes: string | readonly string[]): SmartScope[] {
  const list = typeof scopes === 'string' ? scopes.split(/\s+/) : scopes;
  return list
    .filter(Boolean)
    .map(parseScope)
    .filter((s): s is SmartScope => !!s);
}

/**
 * The scopes that grant a permission on a resource type, in one of the
 * contexts (any, when not given): what an authorizer checks a request with
 */
export function grantingScopes(
  scopes: readonly SmartScope[],
  permission: SmartPermission,
  resourceType: string,
  contexts?: readonly SmartContext[],
): SmartScope[] {
  return scopes.filter(
    s =>
      s.permissions.has(permission) &&
      (s.resourceType === '*' || s.resourceType === resourceType) &&
      (!contexts || contexts.includes(s.context)),
  );
}
