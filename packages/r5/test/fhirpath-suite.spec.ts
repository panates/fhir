import { describeInvariantCheck } from '../../core/test/_support/invariant-check.js';
import {
  describeFhirPathSuite,
  KNOWN_FAILURES,
  SKIPPED_GROUPS,
} from '../../core/test/_support/fhirpath-suite.js';
import { packagePath } from '../../core/test/_support/conformance.js';
import { r5Model } from '../src/index.js';

describeFhirPathSuite({
  version: 'r5',
  model: r5Model,
  examplesDir: packagePath('hl7.fhir.r5.examples#5.0.0'),
  skippedGroups: SKIPPED_GROUPS,
  // a CDA document: a logical model, not in the FHIR model
  skippedInputs: { 'ccda.xml': 'CDA logical model' },
  known: { ...KNOWN_FAILURES },
  minPassing: 1221,
});

describeInvariantCheck('R5', r5Model, {}, 383);
