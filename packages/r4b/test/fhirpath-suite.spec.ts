import { describeInvariantCheck } from '../../core/test/_support/invariant-check.js';
import { packagePath } from '../../core/test/_support/conformance.js';
import {
  describeFhirPathSuite,
  KNOWN_BEFORE_R5,
  KNOWN_FAILURES,
  SKIPPED_GROUPS,
} from '../../core/test/_support/fhirpath-suite.js';
import { r4bModel } from '../src/index.js';

describeFhirPathSuite({
  version: 'r4b',
  model: r4bModel,
  examplesDir: packagePath('hl7.fhir.r4b.examples#4.3.0'),
  skippedGroups: SKIPPED_GROUPS,
  known: { ...KNOWN_FAILURES, ...KNOWN_BEFORE_R5 },
  minPassing: 1068,
});

// Errors of the specification: cid-0 and cnl-0 ask for a name these resources
// do not have; sdf-24 and sdf-25 take the length of an ElementDefinition ($this),
// which R5 corrected to $this.path
const noName = (t: string) =>
  `${t} has no element "name"; ${t} has no element "name"`;
describeInvariantCheck(
  'R4B',
  r4bModel,
  {
    'cid-0@ChargeItemDefinition': noName('ChargeItemDefinition'),
    'cnl-0@Evidence': noName('Evidence'),
    'cnl-0@EvidenceReport': noName('EvidenceReport'),
    'sdf-24@StructureDefinition.snapshot':
      'length() takes a String, not ElementDefinition',
    'sdf-25@StructureDefinition.snapshot':
      'length() takes a String, not ElementDefinition',
  },
  252,
);
