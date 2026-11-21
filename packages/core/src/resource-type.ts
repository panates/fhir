import { getOwnTypeMetadata } from './decorators.js';

/**
 * The resourceType of instances of a class: the name of the nearest
 * concrete @FhirResource in its class chain (a profile class gives its base's)
 */
export function resourceTypeOf(ctor: Function): string | undefined {
  for (let c = ctor; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) {
    const meta = getOwnTypeMetadata(c);
    if (meta?.kind === 'resource') return meta.abstract ? undefined : meta.name;
  }
  return undefined;
}
