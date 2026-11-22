/** An issue of an OperationOutcome */
export interface FhirOutcomeIssue {
  severity: 'fatal' | 'error' | 'warning' | 'information';
  /** An IssueType code: 'not-found', 'conflict', 'invalid', 'not-supported' ... */
  code: string;
  diagnostics?: string;
  expression?: string[];
}

/**
 * An answer other than success: an HTTP status and the issues of the
 * OperationOutcome the server sends. A store throws one to refuse a request
 * (412 for a stale If-Match).
 */
export class FhirServerError extends Error {
  readonly issues: FhirOutcomeIssue[];

  constructor(
    readonly status: number,
    message: string,
    code = 'processing',
    issues?: FhirOutcomeIssue[],
  ) {
    super(message);
    this.name = 'FhirServerError';
    this.issues = issues?.length
      ? issues
      : [{ severity: 'error', code, diagnostics: message }];
  }

  /** The OperationOutcome resource */
  outcome(): Record<string, any> {
    return { resourceType: 'OperationOutcome', issue: this.issues };
  }
}
