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
  /** An instant as the text of its milliseconds since 1970: a version */
  epochMillis(expr: string): string;
  /**
   * What a refused write broke, from the database's error: a unique key, a
   * foreign key, or a value or constraint of the table; undefined for any
   * other error
   */
  refusal(error: unknown): 'unique' | 'reference' | 'invalid' | undefined;
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
  epochMillis: e =>
    `cast(cast(floor(extract(epoch from ${e}) * 1000) as bigint) as text)`,
  refusal: error => {
    // the SQLSTATE of the driver's error, under sqb's
    const code: unknown = (error as any)?.cause?.code ?? (error as any)?.code;
    if (typeof code !== 'string') return;
    if (code === '23505') return 'unique';
    if (code === '23503') return 'reference';
    // not null, check, a value of the wrong form or out of range
    if (code === '23502' || code === '23514' || code.startsWith('22'))
      return 'invalid';
  },
};
