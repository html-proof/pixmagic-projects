// An automation's conditions: a small declarative tree, never code. Customers build it in the UI
// (or send it as JSON); the API validates it against the event type's fields before saving, and the
// evaluator below runs it against an event's data. The tree is bounded (depth, size, list and
// string lengths), so evaluating one is bounded too.

import { z } from "../zod";
import { eventFields, fieldType, readPath, type FieldType } from "./events";

export const COMPARISON_OPERATORS = [
  "equals",
  "not_equals",
  "greater_than",
  "greater_or_equal",
  "less_than",
  "less_or_equal",
  "contains",
  "not_contains",
  "in",
  "not_in",
  "exists",
  "not_exists",
] as const;
export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];
export const GROUP_OPERATORS = ["and", "or"] as const;
export type GroupOperator = (typeof GROUP_OPERATORS)[number];

export type Scalar = string | number | boolean;
export type ConditionLeaf = { op: ComparisonOperator; field: string; value?: Scalar | Scalar[] };
export type ConditionGroup = { op: GroupOperator; conditions: ConditionNode[] };
export type ConditionNode = ConditionLeaf | ConditionGroup;

export const CONDITION_LIMITS = { maxDepth: 4, maxNodes: 40, maxListItems: 100, maxStringLength: 500 } as const;

export const OPERATOR_LABEL: Record<ComparisonOperator | GroupOperator, string> = {
  equals: "is",
  not_equals: "is not",
  greater_than: "is more than",
  greater_or_equal: "is at least",
  less_than: "is less than",
  less_or_equal: "is at most",
  contains: "contains",
  not_contains: "does not contain",
  in: "is one of",
  not_in: "is none of",
  exists: "is present",
  not_exists: "is missing",
  and: "all of",
  or: "any of",
};

/** Which operators make sense for a field of each type. */
export const OPERATORS_FOR: Record<FieldType | "any", ComparisonOperator[]> = {
  string: ["equals", "not_equals", "contains", "not_contains", "in", "not_in", "exists", "not_exists"],
  number: ["equals", "not_equals", "greater_than", "greater_or_equal", "less_than", "less_or_equal", "in", "not_in", "exists", "not_exists"],
  boolean: ["equals", "not_equals", "exists", "not_exists"],
  string_list: ["contains", "not_contains", "exists", "not_exists"],
  any: [...COMPARISON_OPERATORS],
};

const scalar = z.union([z.string().max(CONDITION_LIMITS.maxStringLength), z.number().finite(), z.boolean()]);
const leafSchema = z
  .object({
    op: z.enum(COMPARISON_OPERATORS),
    field: z.string().min(1).max(130).regex(/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*){0,4}$/, "Invalid field"),
    value: z.union([scalar, z.array(scalar).max(CONDITION_LIMITS.maxListItems)]).optional(),
  })
  .strict();

/** The tree's shape (types and sizes). Depth, node count and fields are checked by conditionProblems. */
export const conditionNodeSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(GROUP_OPERATORS), conditions: z.array(conditionNodeSchema).min(1).max(CONDITION_LIMITS.maxNodes) }).strict(),
    leafSchema,
  ]),
);

export const isGroup = (n: ConditionNode): n is ConditionGroup => n.op === "and" || n.op === "or";

const needsValue = (op: ComparisonOperator) => op !== "exists" && op !== "not_exists";
const listOp = (op: ComparisonOperator) => op === "in" || op === "not_in";
const numericOp = (op: ComparisonOperator) => op === "greater_than" || op === "greater_or_equal" || op === "less_than" || op === "less_or_equal";

/**
 * Everything wrong with a condition tree for this event type, in words a person can act on. Empty
 * means it may be saved. `null` (no conditions) is always fine: the rule runs for every event.
 */
export function conditionProblems(node: ConditionNode | null, eventType: string): string[] {
  if (!node) return [];
  const problems: string[] = [];
  let nodes = 0;
  const visit = (n: ConditionNode, depth: number) => {
    nodes++;
    if (depth > CONDITION_LIMITS.maxDepth) {
      problems.push(`Conditions can be nested at most ${CONDITION_LIMITS.maxDepth} levels deep.`);
      return;
    }
    if (isGroup(n)) {
      for (const c of n.conditions) visit(c, depth + 1);
      return;
    }
    const type = fieldType(eventType, n.field);
    if (!type) {
      problems.push(`"${n.field}" isn't a field of this event.`);
      return;
    }
    if (!OPERATORS_FOR[type].includes(n.op)) {
      problems.push(`"${OPERATOR_LABEL[n.op]}" can't be used with ${n.field}.`);
      return;
    }
    if (!needsValue(n.op)) return;
    if (n.value === undefined) {
      problems.push(`${n.field}: a value is required.`);
      return;
    }
    if (listOp(n.op)) {
      if (!Array.isArray(n.value) || n.value.length === 0) problems.push(`${n.field}: give at least one value.`);
      else if (type === "number" && n.value.some((v) => typeof v !== "number")) problems.push(`${n.field}: every value must be a number.`);
      return;
    }
    if (Array.isArray(n.value)) {
      problems.push(`${n.field}: give a single value.`);
      return;
    }
    if ((type === "number" || numericOp(n.op)) && typeof n.value !== "number") problems.push(`${n.field}: the value must be a number.`);
    else if (type === "boolean" && typeof n.value !== "boolean") problems.push(`${n.field}: the value must be yes or no.`);
    else if ((type === "string" || type === "string_list") && typeof n.value !== "string") problems.push(`${n.field}: the value must be text.`);
  };
  visit(node, 1);
  if (nodes > CONDITION_LIMITS.maxNodes) problems.push(`A rule can have at most ${CONDITION_LIMITS.maxNodes} conditions.`);
  return [...new Set(problems)].slice(0, 10);
}

/** Case and surrounding spaces don't matter when comparing text. */
const norm = (v: unknown) => String(v).trim().toLowerCase();
/** Only so much of a value is compared: a huge field can't make evaluation slow. */
const cap = (s: string) => (s.length > 10_000 ? s.slice(0, 10_000) : s);

function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

const present = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

function compare(actual: unknown, op: ComparisonOperator, expected: Scalar | Scalar[] | undefined): boolean {
  if (op === "exists") return present(actual);
  if (op === "not_exists") return !present(actual);
  if (expected === undefined) return false;
  // A missing value is "not" anything, and nothing else.
  if (!present(actual)) return op === "not_equals" || op === "not_contains" || op === "not_in";
  if (Array.isArray(actual)) {
    const have = actual.slice(0, CONDITION_LIMITS.maxListItems * 10).map((a) => cap(norm(a)));
    const want = norm(Array.isArray(expected) ? expected[0] : expected);
    if (op === "contains") return have.some((h) => h === want || h.includes(want));
    if (op === "not_contains") return !have.some((h) => h === want || h.includes(want));
    return false;
  }
  if (listOp(op)) {
    const list = (Array.isArray(expected) ? expected : [expected]).map(norm);
    const a = typeof actual === "number" ? String(actual) : norm(actual);
    const hit = list.includes(a) || (asNumber(actual) !== null && list.some((v) => asNumber(v) === asNumber(actual)));
    return op === "in" ? hit : !hit;
  }
  const want = Array.isArray(expected) ? expected[0] : expected;
  if (numericOp(op) || (typeof want === "number" && (op === "equals" || op === "not_equals"))) {
    const a = asNumber(actual);
    const b = asNumber(want);
    if (a === null || b === null) return op === "not_equals";
    switch (op) {
      case "greater_than":
        return a > b;
      case "greater_or_equal":
        return a >= b;
      case "less_than":
        return a < b;
      case "less_or_equal":
        return a <= b;
      case "equals":
        return a === b;
      case "not_equals":
        return a !== b;
      default:
        return false;
    }
  }
  if (typeof want === "boolean" || typeof actual === "boolean") {
    const a = typeof actual === "boolean" ? actual : norm(actual) === "true";
    const b = typeof want === "boolean" ? want : norm(want) === "true";
    return op === "equals" ? a === b : op === "not_equals" ? a !== b : false;
  }
  const a = cap(norm(actual));
  const b = norm(want);
  switch (op) {
    case "equals":
      return a === b;
    case "not_equals":
      return a !== b;
    case "contains":
      return a.includes(b);
    case "not_contains":
      return !a.includes(b);
    default:
      return false;
  }
}

export interface ConditionTrace {
  field: string;
  op: ComparisonOperator;
  expected: Scalar | Scalar[] | undefined;
  /** What the event had (personal fields masked), for dry runs. */
  actual: string;
  pass: boolean;
}

function show(v: unknown, pii: boolean): string {
  if (!present(v)) return "(missing)";
  if (pii) return "(hidden personal data)";
  const s = Array.isArray(v) ? v.slice(0, 10).map(String).join(", ") : String(v);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

/**
 * Run a condition tree against an event's data. `and` needs every child, `or` any one; both stop
 * at the first answer. `null` passes. The trace lists every comparison that was made.
 */
export function evaluateConditions(node: ConditionNode | null, data: unknown, eventType?: string): { pass: boolean; trace: ConditionTrace[] } {
  const trace: ConditionTrace[] = [];
  if (!node) return { pass: true, trace };
  const piiFields = new Set(eventType ? eventFields(eventType).filter((f) => f.pii).map((f) => f.path) : []);
  let budget = CONDITION_LIMITS.maxNodes * 2;
  const run = (n: ConditionNode, depth: number): boolean => {
    if (--budget < 0 || depth > CONDITION_LIMITS.maxDepth + 1) return false;
    if (isGroup(n)) return n.op === "and" ? n.conditions.every((c) => run(c, depth + 1)) : n.conditions.some((c) => run(c, depth + 1));
    const actual = readPath(data, n.field);
    const pass = compare(actual, n.op, n.value);
    trace.push({ field: n.field, op: n.op, expected: n.value, actual: show(actual, piiFields.has(n.field) || /email|name|phone|address|url/.test(n.field)), pass });
    return pass;
  };
  return { pass: run(node, 1), trace };
}

/** A condition tree in words, for rule lists: `Order total is more than 100 and Customer email is present`. */
export function describeConditions(node: ConditionNode | null, eventType: string): string {
  if (!node) return "Every event";
  const labels = new Map(eventFields(eventType).map((f) => [f.path, f.label]));
  const say = (n: ConditionNode, top: boolean): string => {
    if (isGroup(n)) {
      const inner = n.conditions.map((c) => say(c, false)).join(n.op === "and" ? " and " : " or ");
      return top || n.conditions.length === 1 ? inner : `(${inner})`;
    }
    const field = labels.get(n.field) ?? n.field;
    if (!needsValue(n.op)) return `${field} ${OPERATOR_LABEL[n.op]}`;
    const value = Array.isArray(n.value) ? n.value.join(", ") : String(n.value);
    return `${field} ${OPERATOR_LABEL[n.op]} ${value}`;
  };
  return say(node, true);
}
