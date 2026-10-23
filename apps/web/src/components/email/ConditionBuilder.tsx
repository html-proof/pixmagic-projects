"use client";
import { useState } from "react";
import { conditionNodeSchema, CONDITION_LIMITS, isGroup, OPERATOR_LABEL, OPERATORS_FOR, type ComparisonOperator, type ConditionLeaf, type ConditionNode, type EventField, type Scalar } from "@app/shared/email";
import { formIssue } from "@app/shared/zod";

/**
 * The automation builder's conditions: a list of "field operator value" rows joined by "all" or
 * "any". Trees deeper than that (sent through the API, or written in the JSON editor) are edited as
 * JSON. Validation happens on the server; this only keeps the rows well-formed.
 */
export function ConditionBuilder({ value, onChange, fields, customEvent, disabled }: { value: ConditionNode | null; onChange: (v: ConditionNode | null) => void; fields: EventField[]; customEvent: boolean; disabled?: boolean }) {
  const flat = value === null || (isGroup(value) && value.conditions.every((c) => !isGroup(c))) || !isGroup(value);
  const [json, setJson] = useState(!flat);
  const [jsonText, setJsonText] = useState(() => JSON.stringify(value, null, 2));
  const [jsonErr, setJsonErr] = useState<string | null>(null);

  const group = value === null ? { op: "and" as const, conditions: [] as ConditionNode[] } : isGroup(value) ? value : { op: "and" as const, conditions: [value] };
  const rows = group.conditions.filter((c): c is ConditionLeaf => !isGroup(c));
  const emit = (op: "and" | "or", next: ConditionLeaf[]) => onChange(next.length ? { op, conditions: next } : null);
  const typeOf = (field: string) => fields.find((f) => f.path === field)?.type ?? (field.startsWith("data.") ? "any" : "string");

  if (json) {
    return (
      <div className="space-y-2">
        <textarea
          aria-label="Conditions as JSON"
          className="input min-h-[10rem] font-mono text-xs"
          disabled={disabled}
          value={jsonText}
          onChange={(e) => {
            setJsonText(e.target.value);
            try {
              const parsed = e.target.value.trim() ? JSON.parse(e.target.value) : null;
              if (parsed === null) {
                onChange(null);
                setJsonErr(null);
                return;
              }
              const r = conditionNodeSchema.safeParse(parsed, { error: formIssue });
              const issue = r.success ? null : r.error.issues[0];
              if (issue) throw new Error(issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message);
              if (!r.success) throw new Error("Invalid conditions");
              onChange(r.data);
              setJsonErr(null);
            } catch (err) {
              setJsonErr((err as Error).message);
            }
          }}
        />
        {jsonErr && <p className="text-xs text-danger">{jsonErr}</p>}
        <p className="text-xs text-muted">
          Groups: <code>{'{"op":"and"|"or","conditions":[...]}'}</code>; comparisons: <code>{'{"op":"greater_than","field":"order.total","value":100}'}</code>. Up to {CONDITION_LIMITS.maxDepth} levels and {CONDITION_LIMITS.maxNodes} conditions.
        </p>
        {(value === null || (isGroup(value) && value.conditions.every((c) => !isGroup(c)))) && (
          <button type="button" className="text-xs text-accent underline" onClick={() => setJson(false)}>
            Back to the simple editor
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {rows.length > 1 && (
        <label className="flex items-center gap-2 text-sm">
          Send when
          <select className="input w-auto" disabled={disabled} value={group.op} onChange={(e) => emit(e.target.value as "and" | "or", rows)}>
            <option value="and">all of these are true</option>
            <option value="or">any of these is true</option>
          </select>
        </label>
      )}
      {rows.map((row, i) => {
        const type = typeOf(row.field);
        const ops = OPERATORS_FOR[type] as ComparisonOperator[];
        const update = (patch: Partial<ConditionLeaf>) => emit(group.op, rows.map((r, j) => (j === i ? ({ ...r, ...patch } as ConditionLeaf) : r)));
        const needsValue = row.op !== "exists" && row.op !== "not_exists";
        const list = row.op === "in" || row.op === "not_in";
        const parse = (raw: string): Scalar => (type === "number" && raw.trim() !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw);
        return (
          <div key={i} className="grid gap-2 rounded-lg border border-border p-2 sm:grid-cols-[1fr_10rem_1fr_auto]">
            {customEvent ? (
              <input aria-label="Field" className="input" disabled={disabled} list="condition-fields" value={row.field} placeholder="data.plan or customer.email" onChange={(e) => update({ field: e.target.value.trim() })} />
            ) : (
              <select aria-label="Field" className="input" disabled={disabled} value={row.field} onChange={(e) => {
                const t = typeOf(e.target.value);
                const op = (OPERATORS_FOR[t] as ComparisonOperator[]).includes(row.op) ? row.op : (OPERATORS_FOR[t][0] as ComparisonOperator);
                update({ field: e.target.value, op, value: t === "boolean" ? true : undefined });
              }}>
                {fields.map((f) => (
                  <option key={f.path} value={f.path}>
                    {f.label}
                  </option>
                ))}
              </select>
            )}
            <select aria-label="Operator" className="input" disabled={disabled} value={row.op} onChange={(e) => update({ op: e.target.value as ComparisonOperator, value: e.target.value === "in" || e.target.value === "not_in" ? [] : row.value })}>
              {ops.map((op) => (
                <option key={op} value={op}>
                  {OPERATOR_LABEL[op]}
                </option>
              ))}
            </select>
            {!needsValue ? (
              <span />
            ) : type === "boolean" ? (
              <select aria-label="Value" className="input" disabled={disabled} value={String(row.value ?? true)} onChange={(e) => update({ value: e.target.value === "true" })}>
                <option value="true">yes</option>
                <option value="false">no</option>
              </select>
            ) : list ? (
              <input
                aria-label="Values, comma separated"
                className="input"
                disabled={disabled}
                placeholder="Comma separated"
                value={Array.isArray(row.value) ? row.value.join(", ") : ""}
                onChange={(e) => update({ value: e.target.value.split(",").map((s) => s.trim()).filter(Boolean).map(parse) })}
              />
            ) : (
              <input aria-label="Value" className="input" disabled={disabled} type={type === "number" ? "number" : "text"} value={row.value === undefined ? "" : String(row.value)} onChange={(e) => update({ value: parse(e.target.value) })} />
            )}
            <button type="button" className="text-sm text-danger" disabled={disabled} aria-label="Remove condition" onClick={() => emit(group.op, rows.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        );
      })}
      {customEvent && (
        <datalist id="condition-fields">
          {fields.map((f) => (
            <option key={f.path} value={f.path} />
          ))}
        </datalist>
      )}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className="btn-secondary"
          disabled={disabled || rows.length >= 20}
          onClick={() => {
            const first = fields[0];
            const field = first?.path ?? "customer.email";
            const t = typeOf(field);
            emit(group.op, [...rows, { field, op: OPERATORS_FOR[t][0] as ComparisonOperator, ...(t === "boolean" ? { value: true } : {}) }]);
          }}
        >
          Add condition
        </button>
        <button
          type="button"
          className="text-xs text-muted underline"
          onClick={() => {
            setJsonText(JSON.stringify(value, null, 2));
            setJson(true);
          }}
        >
          Edit as JSON
        </button>
      </div>
      {rows.length === 0 && <p className="text-xs text-muted">No conditions: the automation runs for every event of this type.</p>}
    </div>
  );
}
