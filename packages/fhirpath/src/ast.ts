/** A node of a parsed FHIRPath expression */
export type FhirPathNode =
  | LiteralNode
  | IdentifierNode
  | MemberNode
  | FunctionNode
  | IndexNode
  | UnaryNode
  | BinaryNode
  | TypeOpNode
  | VariableNode;

interface Base {
  /** Position in the expression */
  start: number;
  end: number;
}

export type LiteralValue =
  | { type: 'empty' }
  | { type: 'boolean'; value: boolean }
  | { type: 'string'; value: string }
  | { type: 'integer'; value: number }
  | { type: 'decimal'; value: number; text: string }
  | { type: 'date' | 'dateTime' | 'time'; text: string }
  | { type: 'quantity'; value: number; text: string; unit: string };

/** {}, true, 'text', 12, 1.5, @2024-05-01, 5 'mg', 3 days */
export interface LiteralNode extends Base {
  kind: 'literal';
  literal: LiteralValue;
}

/** A name at the start of a path: Patient, name */
export interface IdentifierNode extends Base {
  kind: 'identifier';
  name: string;
}

/** target.name */
export interface MemberNode extends Base {
  kind: 'member';
  target: FhirPathNode;
  name: string;
}

/** name(args) or target.name(args) */
export interface FunctionNode extends Base {
  kind: 'function';
  target?: FhirPathNode;
  name: string;
  args: FhirPathNode[];
}

/** target[index] */
export interface IndexNode extends Base {
  kind: 'index';
  target: FhirPathNode;
  index: FhirPathNode;
}

/** +x, -x */
export interface UnaryNode extends Base {
  kind: 'unary';
  op: '+' | '-';
  operand: FhirPathNode;
}

export type BinaryOp =
  | '*'
  | '/'
  | 'div'
  | 'mod'
  | '+'
  | '-'
  | '&'
  | '|'
  | '<'
  | '>'
  | '<='
  | '>='
  | '='
  | '~'
  | '!='
  | '!~'
  | 'in'
  | 'contains'
  | 'and'
  | 'or'
  | 'xor'
  | 'implies';

export interface BinaryNode extends Base {
  kind: 'binary';
  op: BinaryOp;
  left: FhirPathNode;
  right: FhirPathNode;
}

/** x is Type, x as Type */
export interface TypeOpNode extends Base {
  kind: 'typeop';
  op: 'is' | 'as';
  operand: FhirPathNode;
  /** 'Patient', 'FHIR.string', 'System.Boolean' */
  typeName: string;
}

/** $this, $index, $total, %resource, %context */
export interface VariableNode extends Base {
  kind: 'variable';
  /** With its sigil: '$this', '%resource' */
  name: string;
}
