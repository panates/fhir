/**
 * Search parameters: `{ name: 'smith', birthdate: ['ge1970', 'lt1980'] }`.
 * A value list repeats the parameter (both must hold, AND); several values
 * of which one must hold (OR) are one value with commas: `'smith,jones'`,
 * as FHIR writes them. Modifiers and chains are in the key: `'name:exact'`,
 * `'subject:Patient.name'`. undefined and null leave a parameter out.
 */
export type FhirSearchValue = string | number | boolean | Date;
export type FhirSearchParams =
  | Record<
      string,
      FhirSearchValue | readonly FhirSearchValue[] | undefined | null
    >
  | URLSearchParams;

/** A Date as FHIR writes it in a search: its instant, in UTC */
const valueOf = (v: FhirSearchValue): string =>
  v instanceof Date ? v.toISOString() : String(v);

/** Search parameters as URLSearchParams */
export function toSearchParams(
  params: FhirSearchParams | undefined,
): URLSearchParams {
  if (!params) return new URLSearchParams();
  if (params instanceof URLSearchParams) return new URLSearchParams(params);
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    for (const v of Array.isArray(value) ? value : [value])
      out.append(key, valueOf(v as FhirSearchValue));
  }
  return out;
}
