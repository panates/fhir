import { packagePath } from '../../core/test/_support/conformance.js';
import {
  describeFhirPathSuite,
  KNOWN_BEFORE_R5,
  KNOWN_FAILURES,
  SKIPPED_GROUPS,
} from '../../core/test/_support/fhirpath-suite.js';
import { describeInvariantCheck } from '../../core/test/_support/invariant-check.js';
import { r4Model } from '../src/index.js';

describeFhirPathSuite({
  version: 'r4',
  model: r4Model,
  examplesDir: packagePath('hl7.fhir.r4.examples#4.0.1'),
  skippedGroups: SKIPPED_GROUPS,
  known: { ...KNOWN_FAILURES, ...KNOWN_BEFORE_R5 },
  minPassing: 1070,
});

// Errors of the specification: cid-0 asks for a name ChargeItemDefinition does not have
describeInvariantCheck(
  'R4',
  r4Model,
  {
    'cid-0@ChargeItemDefinition': 'ChargeItemDefinition has no element "name"',
  },
  241,
);
