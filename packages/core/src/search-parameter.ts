/** The type of a search parameter, as SearchParameter.type has it */
export type FhirSearchParamType =
  | 'number'
  | 'date'
  | 'string'
  | 'token'
  | 'reference'
  | 'composite'
  | 'quantity'
  | 'uri'
  | 'special';

/**
 * What a server needs of a SearchParameter resource to answer a search: the
 * generated packages list those of their FHIR version, and an implementation
 * guide's package adds its own.
 */
export interface FhirSearchParameter {
  /** Canonical URL: 'http://hl7.org/fhir/SearchParameter/Patient-birthdate' */
  url: string;
  /** The name in a search URL: 'birthdate' */
  code: string;
  type: FhirSearchParamType;
  /** The resource types it applies to: ['Patient'], or ['Resource'] for _id */
  base: string[];
  /**
   * The FHIRPath expression of the values it matches, over every base type
   * (one expression may list several: 'Patient.birthDate | Person.birthDate').
   * Absent for parameters a server implements by hand (_text, _has, _filter).
   */
  expression?: string;
  /** The resource types a reference parameter may point to */
  target?: string[];
  /** The parts of a composite parameter: their definitions and expressions */
  component?: { definition: string; expression: string }[];
}

/** The search parameter of a SearchParameter resource; undefined when it has no code, type or base */
export function searchParameterOf(
  resource: any,
): FhirSearchParameter | undefined {
  if (
    !resource ||
    typeof resource.code !== 'string' ||
    typeof resource.type !== 'string' ||
    !Array.isArray(resource.base) ||
    !resource.base.length
  )
    return;
  const p: FhirSearchParameter = {
    url: resource.url,
    code: resource.code,
    type: resource.type,
    base: [...resource.base],
  };
  if (resource.expression) p.expression = resource.expression;
  if (resource.target?.length) p.target = [...resource.target];
  if (resource.component?.length)
    p.component = resource.component.map((c: any) => ({
      definition: c.definition,
      expression: c.expression,
    }));
  return p;
}
