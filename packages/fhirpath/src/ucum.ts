/*
 * The part of UCUM FHIRPath needs to compare and multiply quantities: base
 * units with prefixes, products, quotients and powers ('mg', 'kg/m2',
 * 'mm[Hg]', '[in_i]'). A unit is reduced to a factor and the powers of the
 * base dimensions: 4 'g' = 4000 'mg' because both are 4 g.
 */

/** A unit as a factor of the base units and their powers */
export interface Canonical {
  factor: number;
  /** base unit -> power: { g: 1, m: -2 } */
  dims: Record<string, number>;
}

/** Atoms: factor and dimensions in base units (g, m, s, mol, K, rad, unity) */
const ATOMS: Record<string, [number, Record<string, number>]> = {
  g: [1, { g: 1 }],
  m: [1, { m: 1 }],
  s: [1, { s: 1 }],
  mol: [1, { mol: 1 }],
  K: [1, { K: 1 }],
  rad: [1, { rad: 1 }],
  L: [0.001, { m: 3 }],
  l: [0.001, { m: 3 }],
  min: [60, { s: 1 }],
  h: [3600, { s: 1 }],
  d: [86400, { s: 1 }],
  wk: [604800, { s: 1 }],
  mo: [2629800, { s: 1 }],
  a: [31557600, { s: 1 }],
  Hz: [1, { s: -1 }],
  N: [1000, { g: 1, m: 1, s: -2 }],
  Pa: [1000, { g: 1, m: -1, s: -2 }],
  J: [1000, { g: 1, m: 2, s: -2 }],
  W: [1000, { g: 1, m: 2, s: -3 }],
  'mm[Hg]': [133322.387415, { g: 1, m: -1, s: -2 }],
  '[in_i]': [0.0254, { m: 1 }],
  '[ft_i]': [0.3048, { m: 1 }],
  '[yd_i]': [0.9144, { m: 1 }],
  '[mi_i]': [1609.344, { m: 1 }],
  '[lb_av]': [453.59237, { g: 1 }],
  '[oz_av]': [28.349523125, { g: 1 }],
  '[pt_us]': [0.000473176473, { m: 3 }],
  '%': [0.01, {}],
  '1': [1, {}],
  '[iU]': [1, { '[iU]': 1 }],
  '[IU]': [1, { '[iU]': 1 }],
  eq: [1, { eq: 1 }],
};

const PREFIXES: Record<string, number> = {
  Y: 1e24,
  Z: 1e21,
  E: 1e18,
  P: 1e15,
  T: 1e12,
  G: 1e9,
  M: 1e6,
  k: 1e3,
  h: 1e2,
  da: 1e1,
  d: 1e-1,
  c: 1e-2,
  m: 1e-3,
  u: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
  a: 1e-18,
};

const cache = new Map<string, Canonical | null>();

/** One term: an atom with a prefix and a power ('mg', 'm2', 'cm-1', '10*3') */
function term(t: string): Canonical | undefined {
  if (/^\d+$/.test(t)) return { factor: Number(t), dims: {} };
  const tenPow = /^10\*(-?\d+)$/.exec(t) || /^10\^(-?\d+)$/.exec(t);
  if (tenPow) return { factor: 10 ** Number(tenPow[1]), dims: {} };
  const m = /^(.*?)(-?\d+)?$/.exec(t)!;
  const name = m[1];
  const power = m[2] ? Number(m[2]) : 1;
  let base: [number, Record<string, number>] | undefined = ATOMS[name];
  if (!base) {
    for (const [p, f] of Object.entries(PREFIXES)) {
      if (
        name.startsWith(p) &&
        ATOMS[name.slice(p.length)] &&
        !name.slice(p.length).startsWith('[')
      ) {
        const [af, ad] = ATOMS[name.slice(p.length)];
        base = [af * f, ad];
        break;
      }
    }
  }
  if (!base) return;
  const dims: Record<string, number> = {};
  for (const [k, v] of Object.entries(base[1])) dims[k] = v * power;
  return { factor: base[0] ** power, dims };
}

function multiply(a: Canonical, b: Canonical, sign = 1): Canonical {
  const dims = { ...a.dims };
  for (const [k, v] of Object.entries(b.dims)) {
    dims[k] = (dims[k] ?? 0) + sign * v;
    if (!dims[k]) delete dims[k];
  }
  return { factor: sign > 0 ? a.factor * b.factor : a.factor / b.factor, dims };
}

/** A UCUM unit as a factor of base units; undefined when it is not known */
export function canonical(unit: string): Canonical | undefined {
  let c = cache.get(unit);
  if (c === undefined) {
    c = parseUnit(unit) ?? null;
    cache.set(unit, c);
  }
  return c ?? undefined;
}

function parseUnit(unit: string): Canonical | undefined {
  const u = unit.replace(/\{[^}]*\}/g, '').trim(); // annotations: {beats}/min
  if (!u) return { factor: 1, dims: {} };
  // a/b/c is a / b / c; a.b is a times b
  let result: Canonical | undefined;
  let sign = 1;
  for (const part of u.split(/(\/)/)) {
    if (part === '/') {
      sign = -1;
      continue;
    }
    if (!part) continue;
    for (const t of part.split('.')) {
      const c = term(t);
      if (!c) return;
      result = result
        ? multiply(result, c, sign)
        : sign > 0
          ? c
          : multiply({ factor: 1, dims: {} }, c, -1);
    }
    sign = 1;
  }
  return result;
}

export const sameDims = (a: Canonical, b: Canonical): boolean => {
  const ka = Object.keys(a.dims);
  return (
    ka.length === Object.keys(b.dims).length &&
    ka.every(k => a.dims[k] === b.dims[k])
  );
};

/** A unit string for canonical dimensions: { m: 2 } is 'm2', { g: 1, m: -1 } 'g/m' */
export function unitOf(dims: Record<string, number>): string {
  const num = Object.entries(dims)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => (v === 1 ? k : `${k}${v}`));
  const den = Object.entries(dims)
    .filter(([, v]) => v < 0)
    .map(([k, v]) => (v === -1 ? k : `${k}${-v}`));
  if (!num.length && !den.length) return '1';
  return (
    (num.length ? num.join('.') : '1') + (den.length ? '/' + den.join('.') : '')
  );
}
