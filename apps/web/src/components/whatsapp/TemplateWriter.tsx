"use client";
import { useMemo, useState } from "react";
import {
  checkTemplateDraft,
  countVariables,
  fillText,
  TEMPLATE_CATEGORIES,
  TEMPLATE_CATEGORY_INFO,
  TEMPLATE_LANGUAGES,
  templateDraftSchema,
  type StarterTemplate,
  type TemplateCategory,
} from "@app/shared/whatsapp";
import { Alert } from "@/components/ui";
import { api } from "@/lib/api";
import { ChatBubble, Field, Hint, useWaAction } from "./WaUi";

type Button = { type: "quick_reply"; text: string } | { type: "url"; text: string; url: string; example?: string };

interface Draft {
  name: string;
  language: string;
  category: TemplateCategory;
  headerType: "none" | "text";
  headerText: string;
  headerExample: string;
  body: string;
  bodyExamples: string[];
  footer: string;
  buttons: Button[];
}

const blank: Draft = { name: "", language: "en", category: "UTILITY", headerType: "none", headerText: "", headerExample: "", body: "", bodyExamples: [], footer: "", buttons: [] };

function fromStarter(s: StarterTemplate): Draft {
  const d = s.draft;
  return {
    name: d.name,
    language: d.language,
    category: d.category,
    headerType: d.header.type,
    headerText: d.header.type === "text" ? d.header.text : "",
    headerExample: d.header.type === "text" ? (d.header.example ?? "") : "",
    body: d.body,
    bodyExamples: [...d.bodyExamples],
    footer: d.footer ?? "",
    buttons: d.buttons.map((b) => ({ ...b })),
  };
}

/** The draft as the API takes it (templateDraftSchema's input). */
function payload(d: Draft) {
  const n = countVariables(d.body);
  return {
    name: d.name,
    language: d.language,
    category: d.category,
    header: d.headerType === "text" ? { type: "text" as const, text: d.headerText, ...(d.headerExample.trim() ? { example: d.headerExample } : {}) } : { type: "none" as const },
    body: d.body,
    bodyExamples: d.bodyExamples.slice(0, n).map((x) => x.trim()),
    footer: d.footer.trim() || null,
    buttons: d.buttons.map((b) => (b.type === "url" ? { type: "url" as const, text: b.text, url: b.url, ...(b.example?.trim() ? { example: b.example } : {}) } : b)),
  };
}

/** Write a template (from a starter or blank) and submit it for Meta's review. */
export function TemplateWriter({ base, starters, onDone, onCancel }: { base: string; starters: StarterTemplate[]; onDone: () => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft | null>(null);
  const { busy, run } = useWaAction();
  const set = (patch: Partial<Draft>) => setD((x) => (x ? { ...x, ...patch } : x));
  const vars = d ? countVariables(d.body) : 0;
  const parsed = useMemo(() => (d ? templateDraftSchema.safeParse(payload(d)) : null), [d]);
  const issues = useMemo(() => (parsed?.success ? checkTemplateDraft(parsed.data) : []), [parsed]);
  const schemaErrors = parsed && !parsed.success ? [...new Set(parsed.error.issues.map((i) => i.message))].slice(0, 4) : [];
  const errors = [...schemaErrors, ...issues.filter((i) => i.level === "error").map((i) => i.message)];
  const warnings = issues.filter((i) => i.level === "warning").map((i) => i.message);

  if (!d) {
    return (
      <section className="card animate-rise space-y-4" aria-labelledby="wa-start-tpl-h">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="wa-start-tpl-h" className="font-semibold">
            New template
          </h2>
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Back to templates
          </button>
        </div>
        <p className="text-sm text-muted">Start from one written for the job, then change any words you like. Meta reviews every template before it can be sent, usually within minutes.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {starters.map((s) => (
            <button key={s.key} type="button" className="lift rounded-lg border border-border bg-surface p-3 text-left hover:border-accent" onClick={() => setD(fromStarter(s))}>
              <p className="text-sm font-semibold">{s.title}</p>
              <p className="mt-1 text-xs text-muted">{s.description}</p>
              <p className="mt-2 text-xs">{TEMPLATE_CATEGORY_INFO[s.draft.category].label}</p>
            </button>
          ))}
          <button type="button" className="rounded-lg border border-dashed border-border p-3 text-left hover:border-accent" onClick={() => setD({ ...blank })}>
            <p className="text-sm font-semibold">Start from scratch</p>
            <p className="mt-1 text-xs text-muted">Write your own words.</p>
          </button>
        </div>
      </section>
    );
  }

  const examples = d.bodyExamples;
  const submit = () =>
    run("submit", "submit the template", async () => {
      await api(`${base}/templates`, { method: "POST", body: payload(d) });
      onDone();
      return "Submitted to Meta for review. It usually takes a few minutes; this page shows when it's approved.";
    });

  return (
    <section className="card animate-rise space-y-4" aria-labelledby="wa-write-h">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="wa-write-h" className="font-semibold">
          Write a template
        </h2>
        <button type="button" className="btn-secondary" onClick={() => setD(null)}>
          Choose another starting point
        </button>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="tpl-name" help="Lowercase letters, numbers and underscores. Customers don't see it.">
              <input id="tpl-name" className="input" maxLength={512} value={d.name} onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9_]+/g, "_") })} />
            </Field>
            <Field label="Language" htmlFor="tpl-lang">
              <select id="tpl-lang" className="input" value={d.language} onChange={(e) => set({ language: e.target.value })}>
                {TEMPLATE_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <fieldset>
            <legend className="label">
              Kind of message
              <Hint>Meta decides the final category. A template with offers in it is moved to Marketing, which only reaches customers who agreed to marketing.</Hint>
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {TEMPLATE_CATEGORIES.map((c) => (
                <label key={c} className={`flex cursor-pointer gap-2 rounded-lg border p-3 text-sm ${d.category === c ? "border-accent bg-accent/5" : "border-border"}`}>
                  <input type="radio" name="tpl-cat" checked={d.category === c} onChange={() => set({ category: c })} />
                  <span>
                    <span className="font-medium">{TEMPLATE_CATEGORY_INFO[c].label}</span>
                    <span className="block text-xs text-muted">{TEMPLATE_CATEGORY_INFO[c].help}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="label">Header (optional)</legend>
            <select className="input max-w-xs" aria-label="Header" value={d.headerType} onChange={(e) => set({ headerType: e.target.value as Draft["headerType"] })}>
              <option value="none">No header</option>
              <option value="text">A line of bold text</option>
            </select>
            {d.headerType === "text" && (
              <div className="grid gap-2 sm:grid-cols-2">
                <input className="input" aria-label="Header text" maxLength={60} placeholder="Your order is on its way" value={d.headerText} onChange={(e) => set({ headerText: e.target.value })} />
                {countVariables(d.headerText) > 0 && <input className="input" aria-label="Example for the header's variable" placeholder="Example value" value={d.headerExample} onChange={(e) => set({ headerExample: e.target.value })} />}
              </div>
            )}
          </fieldset>
          <div>
            <div className="flex flex-wrap items-end justify-between gap-2">
              <label className="label" htmlFor="tpl-body">
                Message
              </label>
              <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => set({ body: `${d.body}${d.body && !/\s$/.test(d.body) ? " " : ""}{{${vars + 1}}}` })}>
                Add a blank ({`{{${vars + 1}}}`})
              </button>
            </div>
            <textarea id="tpl-body" className="input min-h-32" maxLength={1024} value={d.body} onChange={(e) => set({ body: e.target.value })} />
            <p className="mt-1 text-xs text-muted">{d.body.length} / 1,024 characters. Blanks like {"{{1}}"} are filled for each customer (their name, the order number…) when it is sent.</p>
          </div>
          {vars > 0 && (
            <fieldset className="space-y-2">
              <legend className="label">
                Example for each blank
                <Hint>Meta&apos;s reviewers read your template with these. Use realistic values, never a real customer&apos;s details.</Hint>
              </legend>
              {Array.from({ length: vars }, (_x, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-10 text-sm text-muted">{`{{${i + 1}}}`}</span>
                  <input
                    className="input"
                    aria-label={`Example for {{${i + 1}}}`}
                    maxLength={200}
                    value={examples[i] ?? ""}
                    onChange={(e) => {
                      const next = [...examples];
                      next[i] = e.target.value;
                      set({ bodyExamples: next });
                    }}
                  />
                </div>
              ))}
            </fieldset>
          )}
          <Field label="Footer (optional)" htmlFor="tpl-footer" help='Small grey text under the message, such as "Reply STOP to unsubscribe".'>
            <input id="tpl-footer" className="input" maxLength={60} value={d.footer} onChange={(e) => set({ footer: e.target.value })} />
          </Field>
          <fieldset className="space-y-2">
            <legend className="label">Buttons (optional, up to 3)</legend>
            {d.buttons.map((b, i) => (
              <div key={i} className="grid gap-2 rounded-lg border border-border p-2 sm:grid-cols-[9rem_1fr_auto]">
                <select
                  className="input"
                  aria-label={`Button ${i + 1} kind`}
                  value={b.type}
                  onChange={(e) => set({ buttons: d.buttons.map((x, j) => (j === i ? (e.target.value === "url" ? { type: "url", text: x.text, url: "https://" } : { type: "quick_reply", text: x.text }) : x)) })}
                >
                  <option value="quick_reply">Quick reply</option>
                  <option value="url">Link</option>
                </select>
                <input className="input" aria-label={`Button ${i + 1} label`} maxLength={25} placeholder="Label" value={b.text} onChange={(e) => set({ buttons: d.buttons.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} />
                <button type="button" className="btn-secondary" onClick={() => set({ buttons: d.buttons.filter((_x, j) => j !== i) })}>
                  Remove
                </button>
                {b.type === "url" && (
                  <>
                    <input className="input sm:col-span-2" aria-label={`Button ${i + 1} link`} placeholder="https://yourstore.com/orders/{{1}}" value={b.url} onChange={(e) => set({ buttons: d.buttons.map((x, j) => (j === i ? { ...(x as Extract<Button, { type: "url" }>), url: e.target.value } : x)) })} />
                    {countVariables(b.url) > 0 && (
                      <input
                        className="input sm:col-span-2"
                        aria-label={`Button ${i + 1} example link`}
                        placeholder="An example of the full link"
                        value={b.example ?? ""}
                        onChange={(e) => set({ buttons: d.buttons.map((x, j) => (j === i ? { ...(x as Extract<Button, { type: "url" }>), example: e.target.value } : x)) })}
                      />
                    )}
                  </>
                )}
              </div>
            ))}
            {d.buttons.length < 3 && (
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => set({ buttons: [...d.buttons, { type: "quick_reply", text: d.category === "MARKETING" && !d.buttons.length ? "Stop promotions" : "" }] })}>
                  Add a quick reply
                </button>
                <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => set({ buttons: [...d.buttons, { type: "url", text: "", url: "https://" }] })}>
                  Add a link
                </button>
              </div>
            )}
          </fieldset>
        </div>
        <div className="space-y-2">
          <p className="label">How customers see it</p>
          <ChatBubble
            header={d.headerType === "text" && d.headerText ? <p className="mb-1 font-semibold">{fillText(d.headerText, [d.headerExample || "{{1}}"])}</p> : null}
            body={fillText(d.body, examples)}
            footer={d.footer || null}
            buttons={d.buttons.map((b) => b.text).filter(Boolean)}
          />
        </div>
      </div>
      {errors.length > 0 && (
        <Alert kind="info">
          <strong>Before it can be submitted:</strong>
          <ul className="mt-1 list-disc pl-5">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Alert>
      )}
      {warnings.length > 0 && (
        <Alert kind="info">
          <ul className="list-disc pl-5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary" disabled={errors.length > 0 || busy === "submit"} onClick={() => void submit()}>
          {busy === "submit" ? "Submitting…" : "Submit to Meta for review"}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
