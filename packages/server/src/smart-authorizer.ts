import type { FhirContext } from '@fhirjs/core';
import {
  grantingScopes,
  parseScopes,
  type SmartPermission,
  type SmartScope,
} from '@fhirjs/smart';
import { SearchMatcher } from './search-match.js';
import {
  parseCriterion,
  SEARCH_TYPES,
  type SearchCriterion,
} from './search-query.js';
import type {
  FhirAccess,
  FhirAccessDecision,
  FhirAuthorizer,
  FhirInteraction,
  FhirPrincipal,
} from './security.js';

export interface SmartAuthorizerOptions {
  /** The model: its search parameters and the Patient compartment */
  fhir: FhirContext;
  /**
   * The rules of `user/` scopes, the hospital's own: which users may see and
   * write what. Asked after the scope granted the interaction. Without it, a
   * `user/` scope grants what it names on every resource.
   */
  user?: FhirAuthorizer;
}

/** The permission each interaction needs */
const PERMISSION: Record<FhirInteraction, SmartPermission> = {
  read: 'r',
  vread: 'r',
  history: 'r',
  validate: 'r',
  search: 's',
  create: 'c',
  update: 'u',
  patch: 'u',
  delete: 'd',
};

const allow: FhirAccessDecision = { allowed: true };
const deny = (reason: string): FhirAccessDecision => ({
  allowed: false,
  reason,
});

/**
 * An authorizer by SMART on FHIR scopes (v1 and v2), in their contexts:
 *
 * - `system/`: what the scope names, on every resource;
 * - `patient/`: on the resources in the Patient compartment of the
 *   principal's patient (those of types not in the compartment, such as a
 *   Medication, are not restricted); a search gets the compartment as one
 *   more criterion;
 * - `user/`: what the scope names, then the `user` authorizer's rules.
 *
 * A v2 scope's query (`patient/Observation.rs?category=laboratory`)
 * restricts it further. With several scopes, a resource is allowed when one
 * of them allows it; a search takes the least restricted one.
 */
export class SmartAuthorizer implements FhirAuthorizer {
  private readonly _matcher: SearchMatcher;

  constructor(readonly options: SmartAuthorizerOptions) {
    this._matcher = new SearchMatcher(options.fhir);
  }

  async authorize(access: FhirAccess): Promise<FhirAccessDecision> {
    const p = access.principal;
    if (!p) return deny('Authentication is required');
    const permission = PERMISSION[access.interaction];
    const scopes = parseScopes(p.scopes);
    const type = access.type;
    if (!type) {
      // the history of the whole server: a scope on every type, not of a patient
      return scopes.some(
        s =>
          s.resourceType === '*' &&
          s.permissions.has(permission) &&
          s.context !== 'patient' &&
          !s.query,
      )
        ? allow
        : deny(
            `The scopes do not grant ${access.interaction} of the whole server`,
          );
    }
    const granting = this._usable(
      grantingScopes(scopes, permission, type),
      p,
      type,
    );
    if (!granting.length)
      return deny(
        scopes.some(s => s.context === 'patient') && !p.patient
          ? 'patient/ scopes need a patient in context'
          : `The scopes do not grant ${permission} on ${type}`,
      );
    if (access.interaction !== 'search') {
      // a user/ scope alone: the user's rules decide
      if (granting.every(s => s.context === 'user') && this.options.user)
        return this.options.user.authorize(access);
      return allow;
    }
    // a search: the criteria of the least restricted scope (criteria can only be ANDed)
    const order = (s: SmartScope) =>
      (s.query ? 3 : 0) +
      (s.context === 'patient' ? 2 : s.context === 'user' ? 1 : 0);
    const scope = [...granting].sort((a, b) => order(a) - order(b))[0];
    const criteria: string[] = [];
    if (scope.context === 'user' && this.options.user) {
      const d = await this.options.user.authorize(access);
      if (!d.allowed) return d;
      if (d.criteria) criteria.push(d.criteria);
    }
    if (scope.context === 'patient') {
      const c = this._compartmentCriterion(type, p.patient!);
      if (c) criteria.push(c);
    }
    if (scope.query) criteria.push(scope.query);
    return criteria.length
      ? { allowed: true, criteria: criteria.join('&') }
      : allow;
  }

  async authorizeResource(
    access: FhirAccess,
    resource: Record<string, any>,
  ): Promise<boolean> {
    const p = access.principal;
    if (!p) return false;
    const type = access.type ?? resource.resourceType;
    const granting = this._usable(
      grantingScopes(
        parseScopes(p.scopes),
        PERMISSION[access.interaction],
        type,
      ),
      p,
      type,
    );
    for (const s of granting) {
      if (
        s.query &&
        !this._matcher.matches(resource, this._criteria(type, s.query))
      )
        continue;
      if (s.context === 'patient' && !this.inCompartment(resource, p.patient!))
        continue;
      if (s.context === 'user' && this.options.user?.authorizeResource)
        if (!(await this.options.user.authorizeResource(access, resource)))
          continue;
      return true;
    }
    return false;
  }

  /**
   * Whether a resource is in a patient's compartment: the Patient itself (or
   * one it links), a resource that refers to the patient by one of its
   * compartment parameters, or one of a type not in the compartment
   */
  inCompartment(resource: Record<string, any>, patient: string): boolean {
    const type = resource.resourceType;
    if (type === 'Patient' && resource.id === patient) return true;
    const params = this.options.fhir.model.compartmentParams('Patient', type);
    if (!params) return type !== 'Patient';
    return params.some(code => {
      try {
        return this._matcher.matches(
          resource,
          this._criteria(type, `${code}=Patient/${patient}`),
        );
      } catch {
        return false;
      }
    });
  }

  /** The scopes that can be used: patient/ ones need a patient, a query must be readable */
  private _usable(
    scopes: SmartScope[],
    p: FhirPrincipal,
    type: string,
  ): SmartScope[] {
    return scopes.filter(s => {
      if (s.context === 'patient' && !p.patient) return false;
      if (!s.query) return true;
      try {
        this._criteria(type, s.query);
        return true;
      } catch {
        return false; // a query the server cannot read grants nothing
      }
    });
  }

  /** A search of the Patient compartment, by one parameter: patient, subject, or the first */
  private _compartmentCriterion(
    type: string,
    patient: string,
  ): string | undefined {
    if (type === 'Patient') return `_id=${patient}`;
    const params = this.options.fhir.model.compartmentParams('Patient', type);
    if (!params) return;
    const code = params.includes('patient')
      ? 'patient'
      : params.includes('subject')
        ? 'subject'
        : params[0];
    return `${code}=Patient/${patient}`;
  }

  /** The criteria of a query on a type; throws for a parameter the server cannot search */
  private _criteria(type: string, query: string): SearchCriterion[] {
    const model = this.options.fhir.model;
    const params = model.searchParameters(type);
    const out: SearchCriterion[] = [];
    for (const [name, value] of new URLSearchParams(query)) {
      const colon = name.indexOf(':');
      const code = colon < 0 ? name : name.slice(0, colon);
      const param = params.get(code);
      if (!param || !SEARCH_TYPES.has(param.type) || !param.expression)
        throw new Error(`${type} cannot be searched by ${code}`);
      out.push(
        parseCriterion(
          param,
          colon < 0 ? undefined : name.slice(colon + 1),
          value,
          t => model.resourceTypes().includes(t),
        ),
      );
    }
    return out;
  }
}
