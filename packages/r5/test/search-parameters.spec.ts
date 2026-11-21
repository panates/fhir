import { describeSearchParameters } from '../../core/test/_support/search-parameters.js';
import { R5_SEARCH_PARAMETERS, r5Model } from '../src/index.js';

// four parameters of resources come without an expression in the core package
describeSearchParameters('R5', r5Model, R5_SEARCH_PARAMETERS, 1239, [
  'DomainResource._text',
  'ImagingStudy.reason',
  'Medication.form',
  'MedicationKnowledge.packaging-cost',
  'MedicationKnowledge.packaging-cost-concept',
  'Resource._content',
  'Resource._filter',
  'Resource._has',
  'Resource._list',
  'Resource._query',
  'Resource._text',
  'Resource._type',
]);
