/**
 * Test-only estimator of Shopify's *requested* query cost, derived from the query text
 * so the arithmetic in src/normalize.ts can't silently drift from the queries:
 *   - scalar / enum (field without a selection set) = 0
 *   - object = 1 + its selections
 *   - connection (a `first` argument and a `nodes` selection) = 2 + other selections
 *     (pageInfo counts 1) + first × (1 + node selections)
 *   - list with a `first` argument (no `nodes`) = first × (1 + element selections)
 *   - an inline fragment (`... on Type { … }`) = its selections, counted as the parent's own
 * Handles the subset of GraphQL our read queries use (inline fragments only, no aliases).
 */
interface Field {
  name: string;
  args: Record<string, string>;
  selection: Field[] | null;
}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  const re = /\s+|,|#[^\n]*|"(?:[^"\\]|\\.)*"|\.\.\.|\$?[_A-Za-z][_0-9A-Za-z]*|-?\d+(?:\.\d+)?|[{}():![\]=@]/y;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new Error(`Cannot tokenize at "${src.slice(pos, pos + 20)}"`);
    pos = re.lastIndex;
    const tok = m[0];
    if (/^(\s+|,|#.*)$/.test(tok)) continue;
    tokens.push(tok);
  }
  return tokens;
}

function parse(query: string): Field[] {
  const t = tokenize(query);
  let i = 0;
  const peek = () => t[i];
  const take = (expected?: string) => {
    const tok = t[i++];
    if (tok === undefined || (expected !== undefined && tok !== expected)) throw new Error(`Expected ${expected ?? "token"}, got ${tok}`);
    return tok;
  };
  const skipValue = (): string => {
    const tok = take();
    if (tok === "[" || tok === "{") {
      const close = tok === "[" ? "]" : "}";
      let depth = 1;
      while (depth > 0) {
        const x = take();
        if (x === tok) depth++;
        else if (x === close) depth--;
      }
      return tok;
    }
    return tok;
  };
  const args = (): Record<string, string> => {
    const out: Record<string, string> = {};
    if (peek() !== "(") return out;
    take("(");
    while (peek() !== ")") {
      const name = take();
      take(":");
      out[name] = skipValue();
    }
    take(")");
    return out;
  };
  const selectionSet = (): Field[] => {
    take("{");
    const fields: Field[] = [];
    while (peek() !== "}") {
      if (peek() === "...") {
        take("...");
        take("on");
        take();
        fields.push(...selectionSet());
        continue;
      }
      const name = take();
      const a = args();
      fields.push({ name, args: a, selection: peek() === "{" ? selectionSet() : null });
    }
    take("}");
    return fields;
  };
  // Skip the operation header: `query Name($a: T, ...)`.
  if (peek() === "query") {
    take();
    if (peek() !== "(" && peek() !== "{") take();
    if (peek() === "(") {
      let depth = 0;
      do {
        const x = take();
        if (x === "(") depth++;
        else if (x === ")") depth--;
      } while (depth > 0);
    }
  }
  return selectionSet();
}

function resolveInt(raw: string, vars: Record<string, unknown>): number {
  const v = raw.startsWith("$") ? vars[raw.slice(1)] : raw;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`first=${raw} does not resolve to an integer`);
  return n;
}

function cost(fields: Field[], vars: Record<string, unknown>): number {
  return fields.reduce((sum, f) => sum + fieldCost(f, vars), 0);
}

function fieldCost(f: Field, vars: Record<string, unknown>): number {
  if (!f.selection) return 0;
  const first = f.args.first !== undefined ? resolveInt(f.args.first, vars) : undefined;
  const nodes = f.selection.find((c) => c.name === "nodes");
  if (first !== undefined && nodes) {
    const rest = f.selection.filter((c) => c !== nodes);
    return 2 + cost(rest, vars) + first * (1 + cost(nodes.selection ?? [], vars));
  }
  if (first !== undefined) return first * (1 + cost(f.selection, vars));
  return 1 + cost(f.selection, vars);
}

/** Requested cost of `query` with the given variables (the root QueryRoot is free). */
export function requestedCost(query: string, vars: Record<string, unknown> = {}): number {
  return cost(parse(query), vars);
}
