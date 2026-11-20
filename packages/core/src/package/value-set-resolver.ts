/** Codes of a value set by code system */
export type ValueSetEntries = Record<string, string[]>;

/** Where a value set's references are looked up */
export interface ValueSetLookup {
  /** Codes of another value set, by canonical URL */
  valueSet(url: string): ValueSetEntries | undefined;
  /** Codes of a complete code system, by canonical URL */
  codeSystem(url: string): string[] | undefined;
}

/**
 * Lists the codes of a ValueSet resource from its expansion or compose; the
 * value sets and code systems it uses come from `lookup`. Undefined for a
 * value set that cannot be listed (a filter, a code system not at hand).
 */
export function resolveValueSet(vs: any, lookup: ValueSetLookup): ValueSetEntries | undefined {
  const out: Record<string, Set<string>> = {};
  const add = (system: string | undefined, code: string) => (out[system ?? ''] ||= new Set()).add(code);
  if (Array.isArray(vs?.expansion?.contains)) {
    const walk = (items: any[]) => {
      for (const c of items) {
        if (c.code && !c.abstract) add(c.system, c.code);
        if (Array.isArray(c.contains)) walk(c.contains);
      }
    };
    walk(vs.expansion.contains);
  } else {
    if (!Array.isArray(vs?.compose?.include)) return;
    const part = (inc: any): ValueSetEntries | undefined => {
      if (inc.filter?.length) return;
      const r: ValueSetEntries = {};
      if (inc.system) {
        const codes = Array.isArray(inc.concept)
          ? inc.concept.map((c: any) => c.code)
          : lookup.codeSystem(inc.system);
        if (!codes) return;
        r[inc.system] = codes;
      }
      for (const ref of inc.valueSet || []) {
        const nested = lookup.valueSet(String(ref).split('|')[0]);
        if (!nested) return;
        if (!inc.system) Object.assign(r, nested);
        else r[inc.system] = r[inc.system].filter(c => nested[inc.system]?.includes(c));
      }
      return r;
    };
    for (const inc of vs.compose.include) {
      const r = part(inc);
      if (!r) return;
      for (const [system, codes] of Object.entries(r)) for (const c of codes) add(system, c);
    }
    for (const exc of vs.compose.exclude || []) {
      const r = part(exc);
      if (!r) return;
      for (const [system, codes] of Object.entries(r)) for (const c of codes) out[system]?.delete(c);
    }
  }
  const entries: ValueSetEntries = {};
  for (const [system, codes] of Object.entries(out)) if (codes.size) entries[system] = [...codes];
  return Object.keys(entries).length ? entries : undefined;
}

/**
 * The selectable codes of a complete CodeSystem; undefined for one that is
 * not complete (a fragment, an example, codes not in the resource)
 */
export function codeSystemCodes(cs: any): string[] | undefined {
  if (!Array.isArray(cs?.concept) || cs.content !== 'complete') return;
  const codes: string[] = [];
  const walk = (items: any[]) => {
    for (const c of items) {
      const abstract = c.property?.some(
        (p: any) => (p.code === 'abstract' || p.code === 'notSelectable') && p.valueBoolean,
      );
      if (!abstract && typeof c.code === 'string') codes.push(c.code);
      if (Array.isArray(c.concept)) walk(c.concept);
    }
  };
  walk(cs.concept);
  return codes;
}
