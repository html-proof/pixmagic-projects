"use client";
import { useId } from "react";
import { VARIABLE_INFO, type TemplateMapping, type VariableRef, type VariableSource } from "@app/shared/whatsapp";
import type { WaTemplate } from "./types";
import { Hint, TemplatePreview } from "./WaUi";

/** Fill a mapping with the first allowed variable for every {{n}} the template has, keeping what was chosen. */
export function fitMapping(t: WaTemplate | null, current: TemplateMapping | null, allowed: VariableSource[]): TemplateMapping {
  const first = allowed.find((v) => v !== "custom_text" && v !== "event_value") ?? "custom_text";
  const pick = (r: VariableRef | null | undefined): VariableRef => (r && allowed.includes(r.source) ? r : { source: first });
  if (!t) return current ?? { body: [], buttons: [] };
  return {
    header: t.shape.headerVars ? pick(current?.header) : null,
    body: Array.from({ length: t.shape.bodyVars }, (_x, i) => pick(current?.body[i])),
    buttons: t.shape.dynamicUrlButtons.map((_x, i) => pick(current?.buttons[i])),
  };
}

function RefPicker({ label, value, allowed, onChange }: { label: string; value: VariableRef; allowed: VariableSource[]; onChange: (r: VariableRef) => void }) {
  const id = useId();
  const needsText = value.source === "custom_text" || value.source === "event_value";
  return (
    <div className="grid gap-2 sm:grid-cols-[8rem_1fr_1fr] sm:items-center">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="input" value={value.source} onChange={(e) => onChange({ source: e.target.value as VariableSource })}>
        {allowed.map((v) => (
          <option key={v} value={v}>
            {VARIABLE_INFO[v].label}
          </option>
        ))}
      </select>
      {needsText ? (
        <input
          className="input"
          aria-label={value.source === "custom_text" ? `${label}: the text` : `${label}: the event value's key`}
          placeholder={value.source === "custom_text" ? "The same words for everyone" : "Key, e.g. service"}
          maxLength={300}
          value={value.text ?? ""}
          onChange={(e) => onChange({ ...value, text: e.target.value })}
        />
      ) : (
        <span className="text-xs text-muted">e.g. {VARIABLE_INFO[value.source].sample || "—"}</span>
      )}
    </div>
  );
}

/** Choose what fills each of a template's variables, with the message as the customer will read it. */
export function MappingEditor({
  template,
  mapping,
  onChange,
  allowed,
  headerMediaUrl,
  onHeaderMediaUrl,
}: {
  template: WaTemplate;
  mapping: TemplateMapping;
  onChange: (m: TemplateMapping) => void;
  allowed: VariableSource[];
  headerMediaUrl?: string | null;
  onHeaderMediaUrl?: (url: string) => void;
}) {
  const { shape } = template;
  const media = ["IMAGE", "VIDEO", "DOCUMENT"].includes(shape.headerFormat);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
      <div className="space-y-3">
        {!shape.bodyVars && !shape.headerVars && !shape.dynamicUrlButtons.length && !media ? (
          <p className="text-sm text-muted">This template has no variables: everyone receives the same words.</p>
        ) : (
          <p className="text-sm text-muted">
            Choose what fills each blank.
            <Hint>
              Each {"{{1}}"}, {"{{2}}"}… in the template is filled for each customer when the message is sent. A value the event doesn&apos;t know (an order without a tracking number, say) stops that one
              message, and the history says why.
            </Hint>
          </p>
        )}
        {shape.headerVars > 0 && mapping.header && <RefPicker label="Header" value={mapping.header} allowed={allowed} onChange={(r) => onChange({ ...mapping, header: r })} />}
        {mapping.body.map((r, i) => (
          <RefPicker key={i} label={`{{${i + 1}}}`} value={r} allowed={allowed} onChange={(next) => onChange({ ...mapping, body: mapping.body.map((x, j) => (j === i ? next : x)) })} />
        ))}
        {mapping.buttons.map((r, i) => (
          <RefPicker key={`b${i}`} label={`Link button ${i + 1}`} value={r} allowed={allowed} onChange={(next) => onChange({ ...mapping, buttons: mapping.buttons.map((x, j) => (j === i ? next : x)) })} />
        ))}
        {media && onHeaderMediaUrl && (
          <div>
            <label className="label" htmlFor="wa-media">
              Link to the {shape.headerFormat.toLowerCase()} the header shows
            </label>
            <input id="wa-media" className="input" type="url" placeholder="https://…" value={headerMediaUrl ?? ""} onChange={(e) => onHeaderMediaUrl(e.target.value)} />
            <p className="mt-1 text-xs text-muted">A public https link WhatsApp can download without signing in (JPEG or PNG for images, PDF for documents, MP4 for videos).</p>
          </div>
        )}
      </div>
      <div>
        <p className="label">Preview</p>
        <TemplatePreview components={template.components} mapping={mapping} headerMedia={headerMediaUrl} />
        <p className="mt-1 max-w-sm text-xs text-muted">With sample values. Each customer sees their own.</p>
      </div>
    </div>
  );
}
