import { DECIMAL_TEXT, getDecimalText, markDecimalText } from '@fhirjs/core';
import { FhirServerError } from './fhir-server-error.js';

/** An operation of a JSON Patch (RFC 6902) */
interface Operation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

const OPS = new Set(['add', 'remove', 'replace', 'move', 'copy', 'test']);

/**
 * Applies a JSON Patch to a document, in place, and gives the document (a
 * new one when the root is replaced). A decimal keeps the text it is written
 * with in the patch (1.50). Throws FhirServerError: 400 for a patch that is
 * not one, 422 for one that cannot be applied (a path that is not there, a
 * failed test).
 */
export function applyJsonPatch(document: unknown, patch: unknown): unknown {
  if (!Array.isArray(patch))
    throw new FhirServerError(
      400,
      'A JSON Patch is an array of operations',
      'structure',
    );
  let doc = document;
  patch.forEach((raw, i) => {
    const op = checkOperation(raw, i);
    try {
      doc = apply(doc, op);
    } catch (e) {
      if (e instanceof PatchError)
        throw new FhirServerError(
          422,
          `Patch operation ${i} (${op.op} ${op.path}): ${e.message}`,
          'processing',
        );
      throw e;
    }
  });
  return doc;
}

class PatchError extends Error {}

function checkOperation(raw: unknown, i: number): Operation {
  const op = raw as Operation;
  const bad = (why: string) =>
    new FhirServerError(400, `Patch operation ${i}: ${why}`, 'structure');
  if (!op || typeof op !== 'object' || Array.isArray(op))
    throw bad('not an object');
  if (!OPS.has(op.op)) throw bad(`"${op.op}" is not an operation`);
  if (typeof op.path !== 'string') throw bad('no path');
  pointer(op.path, bad);
  if (
    (op.op === 'add' || op.op === 'replace' || op.op === 'test') &&
    !('value' in op)
  )
    throw bad(`${op.op} needs a value`);
  if ((op.op === 'move' || op.op === 'copy') && typeof op.from !== 'string')
    throw bad(`${op.op} needs from`);
  if (op.from !== undefined) pointer(op.from, bad);
  return op;
}

/** The tokens of a JSON Pointer ('/name/0/given' -> ['name', '0', 'given']) */
function pointer(
  path: string,
  bad: (why: string) => Error = m => new PatchError(m),
): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw bad(`"${path}" is not a JSON Pointer`);
  return path
    .slice(1)
    .split('/')
    .map(t => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** The container of a pointer's last token, and that token */
function parentOf(doc: unknown, path: string): [any, string] {
  const tokens = pointer(path);
  const key = tokens.pop()!;
  let cur: any = doc;
  for (const t of tokens) {
    cur = child(cur, t);
    if (cur === undefined) throw new PatchError(`${path} is not there`);
  }
  if (cur === null || typeof cur !== 'object')
    throw new PatchError(`${path} is not there`);
  return [cur, key];
}

function child(container: any, token: string): any {
  if (Array.isArray(container)) {
    if (!/^(0|[1-9]\d*)$/.test(token)) return;
    return container[Number(token)];
  }
  if (
    container &&
    typeof container === 'object' &&
    Object.hasOwn(container, token)
  )
    return container[token];
}

function get(doc: unknown, path: string): unknown {
  let cur: any = doc;
  for (const t of pointer(path)) {
    cur = child(cur, t);
    if (cur === undefined) throw new PatchError(`${path} is not there`);
  }
  return cur;
}

/** Sets a value at a container's key, with the decimal text it had where it came from */
function put(
  container: any,
  key: string | number,
  value: unknown,
  text: string | undefined,
) {
  container[key] = value;
  if (text !== undefined && typeof value === 'number')
    markDecimalText(container, key, text);
}

function add(
  doc: unknown,
  path: string,
  value: unknown,
  text?: string,
): unknown {
  if (path === '') return value;
  const [container, key] = parentOf(doc, path);
  if (Array.isArray(container)) {
    const i = key === '-' ? container.length : Number(key);
    if (!/^(0|[1-9]\d*|-)$/.test(key) || i > container.length)
      throw new PatchError(`${path}: no such index`);
    container.splice(i, 0, value);
    // the texts of the decimals after it move with them
    const map = (container as any)[DECIMAL_TEXT];
    if (map)
      for (let j = container.length - 1; j > i; j--)
        if (map[j - 1] !== undefined) map[j] = map[j - 1];
    if (text !== undefined && typeof value === 'number')
      markDecimalText(container, i, text);
    else if (map) delete map[i];
  } else put(container, key, value, text);
  return doc;
}

function remove(doc: unknown, path: string): unknown {
  if (path === '') throw new PatchError('the whole document cannot be removed');
  const [container, key] = parentOf(doc, path);
  if (child(container, key) === undefined)
    throw new PatchError(`${path} is not there`);
  if (Array.isArray(container)) container.splice(Number(key), 1);
  else delete container[key];
  return doc;
}

/** A deep copy that keeps the texts of decimals */
function clone(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const out: any = Array.isArray(value) ? value.map(clone) : {};
  if (!Array.isArray(value))
    for (const [k, v] of Object.entries(value)) out[k] = clone(v);
  const map = (value as any)[DECIMAL_TEXT];
  if (map) for (const k of Object.keys(map)) markDecimalText(out, k, map[k]);
  return out;
}

/** Equality as JSON: numbers by value, objects key by key */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  )
    return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every(k => Object.hasOwn(b, k) && equal((a as any)[k], (b as any)[k]))
  );
}

function apply(doc: unknown, op: Operation): unknown {
  switch (op.op) {
    case 'add':
      return add(doc, op.path, op.value, getDecimalText(op, 'value'));
    case 'remove':
      return remove(doc, op.path);
    case 'replace': {
      get(doc, op.path);
      if (op.path === '') return op.value;
      const [container, key] = parentOf(doc, op.path);
      put(
        container,
        Array.isArray(container) ? Number(key) : key,
        op.value,
        getDecimalText(op, 'value'),
      );
      if (getDecimalText(op, 'value') === undefined) {
        const map = container[DECIMAL_TEXT];
        if (map) delete map[key];
      }
      return doc;
    }
    case 'move': {
      if (op.path === op.from) return doc;
      if (op.path.startsWith(op.from! + '/'))
        throw new PatchError('a value cannot be moved into itself');
      const [from, key] = parentOf(doc, op.from!);
      const text = from[DECIMAL_TEXT]?.[key];
      const value = get(doc, op.from!);
      return add(remove(doc, op.from!), op.path, value, text);
    }
    case 'copy': {
      const value = get(doc, op.from!);
      let text: string | undefined;
      if (op.from !== '') {
        const [from, key] = parentOf(doc, op.from!);
        text = from[DECIMAL_TEXT]?.[key];
      }
      return add(doc, op.path, clone(value), text);
    }
    case 'test':
      if (!equal(get(doc, op.path), op.value))
        throw new PatchError('the value is not the one the test expects');
      return doc;
  }
}
