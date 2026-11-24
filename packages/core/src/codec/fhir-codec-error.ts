import type { ErrorIssue } from 'valgen';
import type { FhirIssue } from './types.js';

/** A codec failed: its issues, in the form of OperationOutcome.issue */
export class FhirCodecError extends Error {
  constructor(readonly issues: FhirIssue[]) {
    super(
      issues.length === 1
        ? `${issues[0].expression}: ${issues[0].diagnostics}`
        : `${issues.length} issues: ` +
            issues
              .slice(0, 3)
              .map(i => `${i.expression}: ${i.diagnostics}`)
              .join('; ') +
            (issues.length > 3 ? '; ...' : ''),
    );
    this.name = 'FhirCodecError';
  }
}

/**
 * valgen issues as OperationOutcome issues, located from `root`
 * ('Patient.name[0].given[1]'). An issue found twice (a value checked by its
 * type and by a profile's slice) is kept once.
 */
export function toFhirIssues(issues: ErrorIssue[], root: string): FhirIssue[] {
  const out: FhirIssue[] = [];
  const seen = new Set<string>();
  for (const i of issues) {
    const loc = i.location || '';
    const expression = !loc
      ? root
      : loc.startsWith('[')
        ? root + loc
        : `${root}.${loc}`;
    const key = expression + '\u0000' + i.message;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      severity: 'error',
      code: i.fhirCode || 'structure',
      expression,
      diagnostics: i.message,
    });
  }
  return out;
}
