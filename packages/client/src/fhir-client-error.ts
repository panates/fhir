/** An HTTP error from a FHIR server, with the OperationOutcome it sent */
export class FhirClientError extends Error {
  constructor(
    message: string,
    /** The HTTP status: 404, 412, 422 ... */
    readonly status: number,
    /** The OperationOutcome of the response, as JSON; undefined when there was none */
    readonly outcome?: Record<string, any>,
    /** The method and URL of the request */
    readonly request?: { method: string; url: string },
  ) {
    super(message);
    this.name = 'FhirClientError';
  }

  /** The diagnostics (or details) of the outcome's issues */
  get diagnostics(): string[] {
    const issues: any[] = Array.isArray(this.outcome?.issue)
      ? this.outcome.issue
      : [];
    return issues
      .map(i => i?.diagnostics ?? i?.details?.text)
      .filter((d): d is string => typeof d === 'string');
  }
}
