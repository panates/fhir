/**
 * The SQL that depends on the database. The translators write everything
 * else with sqb; another database is another object of this shape.
 */
export interface SqlDialect {
  /** Text with case and accents removed, as the memory store compares strings */
  normalize(expr: string): string;
  /** Text compared byte by byte, as the memory store sorts strings */
  binary(expr: string): string;
  /** An instant to the millisecond FHIR writes */
  instant(expr: string): string;
  /** A date column as the instant its day starts, in UTC */
  dayStart(expr: string): string;
  /** An instant plus some milliseconds or days */
  plus(expr: string, amount: number, unit: 'millisecond' | 'day'): string;
  /** The instants before and after every other */
  readonly minInstant: string;
  readonly maxInstant: string;
  /** An expression as text */
  text(expr: string): string;
  /** An expression as a double */
  double(expr: string): string;
}

/**
 * PostgreSQL. Strings are normalized with the `unaccent` extension, which
 * must be in the `public` schema.
 */
export const postgres: SqlDialect = {
  normalize: e => `translate(lower(public.unaccent(${e})), 'ı', 'i')`,
  binary: e => `(${e}) collate "C"`,
  instant: e => `date_trunc('milliseconds', ${e})`,
  dayStart: e => `(cast(${e} as timestamp) at time zone 'UTC')`,
  plus: (e, n, unit) => `(${e} + interval '${n} ${unit}')`,
  minInstant: `cast('-infinity' as timestamptz)`,
  maxInstant: `cast('infinity' as timestamptz)`,
  text: e => `cast(${e} as text)`,
  double: e => `cast(${e} as float8)`,
};
