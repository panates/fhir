/** decode: wire (JSON) to model; encode: model to wire */
export type FhirCodecMode = 'decode' | 'encode';

export interface FhirCodecOptions {
  /**
   * Elements the definition does not have: 'error' (default) fails, 'keep'
   * keeps them as they are, 'drop' leaves them out
   */
  unknownElements?: 'error' | 'keep' | 'drop';
  /**
   * Skip cardinality minimums (required elements), for a PATCH body or a
   * resource being built
   */
  partial?: boolean;
  /**
   * decode: return plain objects instead of instances of the generated
   * classes
   */
  plain?: boolean;
  /**
   * Check codes of required bindings against the value sets the model has
   * (default true). Value sets the model does not have are not checked.
   */
  bindings?: boolean;
  /**
   * decode from text: 'exact' (default) keeps the source text of decimals
   * (1.50) next to their number; 'number' keeps the number only
   */
  decimals?: 'exact' | 'number';
  /**
   * encode: write decimals with their kept text as JSON.rawJSON values, for
   * JSON.stringify (used by FhirContext.stringify)
   */
  rawDecimals?: boolean;
  /**
   * decode: read a resource with the registered profile class its
   * meta.profile names (default true)
   */
  profiles?: boolean;
  /**
   * Check an extension against its definition, found by its url, when the
   * model has it (default true)
   */
  extensions?: boolean;
}

/** One problem found by a codec, in the form of an OperationOutcome.issue */
export interface FhirIssue {
  severity: 'fatal' | 'error' | 'warning' | 'information';
  /** OperationOutcome issue type */
  code:
    | 'structure'
    | 'required'
    | 'value'
    | 'invalid'
    | 'not-supported'
    | 'code-invalid'
    | 'invariant'
    | 'exception'
    | 'informational';
  /** Where: 'Patient.name[0].given[1]' */
  expression: string;
  diagnostics: string;
}
