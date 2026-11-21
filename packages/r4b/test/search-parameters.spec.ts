import { describeSearchParameters } from '../../core/test/_support/search-parameters.js';
import { R4B_SEARCH_PARAMETERS, r4bModel } from '../src/index.js';

// Patient.age and Patient.birthOrderBoolean come without an expression in the core package
describeSearchParameters('R4B', r4bModel, R4B_SEARCH_PARAMETERS, 1425, [
  'DomainResource._text',
  'Patient.age',
  'Patient.birthOrderBoolean',
  'Resource._content',
  'Resource._filter',
  'Resource._has',
  'Resource._list',
  'Resource._query',
  'Resource._text',
  'Resource._type',
]);
