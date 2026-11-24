/*
 * A small FHIR XML reader for tests: the HL7 FHIRPath suite reads its inputs
 * from XML files, some of which have no JSON twin. The JSON form is built
 * with the model (which elements repeat, which are primitives and their JSON
 * kind), as the FHIR XML and JSON rules say.
 */
import {
  type FhirModel,
  type FhirTypeInfo,
  markDecimalText,
} from '@fhirjs/core';

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** The source of the element (for xhtml) */
  raw: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#'
      ? String.fromCodePoint(
          e[1] === 'x' || e[1] === 'X'
            ? parseInt(e.slice(2), 16)
            : Number(e.slice(1)),
        )
      : (ENTITIES[e] ?? m),
  );

/** Parses XML elements and attributes; text, comments and declarations are skipped */
function parseXml(src: string): XmlNode {
  let i = 0;
  const stack: XmlNode[] = [];
  const starts: number[] = [];
  let root: XmlNode | undefined;
  const tag =
    /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
  const attr = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) {
      i = src.indexOf('-->', lt) + 3;
      continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      i = src.indexOf('>', lt) + 1;
      continue;
    }
    tag.lastIndex = lt;
    const m = tag.exec(src);
    if (!m) throw new Error(`XML: bad tag at ${lt}`);
    i = tag.lastIndex;
    const name = m[2].replace(/^\w+:/, '');
    if (m[1]) {
      const node = stack.pop()!;
      node.raw = src.slice(starts.pop()!, i);
      if (!stack.length) root = node;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of m[3].matchAll(attr)) attrs[a[1]] = decode(a[2] ?? a[3]);
    const node: XmlNode = { name, attrs, children: [], raw: '' };
    stack.at(-1)?.children.push(node);
    if (m[4]) {
      node.raw = src.slice(lt, i);
      if (!stack.length) root = node;
    } else {
      stack.push(node);
      starts.push(lt);
    }
  }
  if (!root) throw new Error('XML: no root element');
  return root;
}

/** A FHIR resource in XML as its JSON form */
export function fhirXmlToJson(model: FhirModel, xml: string): any {
  return resource(model, parseXml(xml));
}

function resource(model: FhirModel, node: XmlNode): any {
  const json: any = { resourceType: node.name };
  fill(model, model.getType(node.name), node, json);
  return json;
}

function fill(model: FhirModel, type: FhirTypeInfo, node: XmlNode, json: any) {
  if (node.attrs.id !== undefined) json.id = node.attrs.id;
  if (node.attrs.url !== undefined) json.url = node.attrs.url;
  // children, grouped by name in order
  const groups = new Map<string, XmlNode[]>();
  for (const c of node.children) {
    if (!groups.has(c.name)) groups.set(c.name, []);
    groups.get(c.name)!.push(c);
  }
  for (const [key, nodes] of groups) {
    const el = type.keys.get(key);
    const et = el?.types.find(t => t.key === key);
    if (!el || !et) throw new Error(`${type.name}: no element ${key}`);
    const target = model.getType(et.code);
    const values: any[] = [];
    const exts: any[] = [];
    for (const n of nodes) {
      if (key === 'div' && et.code === 'xhtml') {
        values.push(n.raw);
        exts.push(null);
      } else if (target.kind === 'primitive-type') {
        values.push(
          n.attrs.value === undefined ? null : primitive(target, n.attrs.value),
        );
        const x: any = {};
        if (n.attrs.id !== undefined) x.id = n.attrs.id;
        const ext = n.children.filter(c => c.name === 'extension');
        if (ext.length)
          x.extension = ext.map(e =>
            complex(model, model.getType('Extension'), e),
          );
        exts.push(Object.keys(x).length ? x : null);
      } else if (target.kind === 'resource') {
        values.push(resource(model, n.children[0]));
        exts.push(null);
      } else {
        values.push(complex(model, target, n));
        exts.push(null);
      }
    }
    if (values.some(v => v !== null)) {
      json[key] = el.isArray ? values : values[0];
      // decimals keep their text (1.50, 9.5e2), as @fhirjs/core reads JSON
      if (target.json === 'number')
        nodes.forEach((n, i) => {
          const text = n.attrs.value;
          if (text === undefined || String(Number(text)) === text) return;
          if (el.isArray) markDecimalText(values, i, text);
          else markDecimalText(json, key, text);
        });
    }
    if (exts.some(x => x !== null))
      json['_' + key] = el.isArray ? exts : exts[0];
  }
}

function complex(model: FhirModel, type: FhirTypeInfo, node: XmlNode): any {
  const json: any = {};
  fill(model, type, node, json);
  return json;
}

function primitive(type: FhirTypeInfo, value: string): unknown {
  switch (type.json) {
    case 'boolean':
      return value === 'true';
    case 'number':
      return Number(value);
    default:
      return value;
  }
}
