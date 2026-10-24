"use client";
import { useMemo, useState } from "react";
import type { TemplateMapping, VariableSource } from "@app/shared/whatsapp";
import { Dialog } from "@/components/AppUi";
import { Alert } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { fitMapping, MappingEditor } from "./MappingEditor";
import type { WaContact, WaTemplatesAnswer } from "./types";
import { useWaAction, waError } from "./WaUi";

/** What a message sent by hand can fill a template with: the customer and the store, or fixed text. */
const MANUAL_VARIABLES: VariableSource[] = ["customer_first_name", "store_name", "custom_text"];

type Kind = "template" | "text" | "media";

/**
 * Send one message: an approved template to a customer who agreed to receive it, or (within 24
 * hours of their last message) a free-form reply. The API checks both again and says why when it
 * refuses.
 */
export function SendMessage({ base, contact, open, onClose, onSent }: { base: string; contact: WaContact | null; open: boolean; onClose: () => void; onSent: () => void }) {
  const templates = useApi<WaTemplatesAnswer>(open ? `${base}/templates` : null);
  const approved = useMemo(() => (templates.data?.templates ?? []).filter((t) => t.status === "APPROVED" && t.category !== "AUTHENTICATION"), [templates.data]);
  const [phone, setPhone] = useState("");
  const [kind, setKind] = useState<Kind>(contact?.windowOpen ? "text" : "template");
  const [ref, setRef] = useState("");
  const [mapping, setMapping] = useState<TemplateMapping>({ body: [], buttons: [] });
  const [media, setMedia] = useState("");
  const [text, setText] = useState("");
  const [mediaType, setMediaType] = useState<"image" | "document" | "video">("image");
  const [link, setLink] = useState("");
  const [caption, setCaption] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const { busy, run } = useWaAction();
  const template = approved.find((t) => `${t.name}|${t.language}` === ref) ?? null;
  const windowOpen = !!contact?.windowOpen;

  const send = () =>
    run("send", "send the message", async () => {
      setError(null);
      const message =
        kind === "template"
          ? { kind, template: { name: template!.name, language: template!.language }, mapping, headerMediaUrl: media.trim() || null }
          : kind === "text"
            ? { kind, body: text }
            : { kind, mediaType, link, caption: caption.trim() || null };
      try {
        await api(`${base}/messages`, { method: "POST", body: { requestId, to: contact ? { contactId: contact.id } : { phone }, message } });
      } catch (e) {
        setError(waError(e, "send the message"));
        throw e;
      }
      setRequestId(crypto.randomUUID());
      onSent();
      onClose();
      return "Message queued. Its status appears in the history within moments.";
    });

  const ready = kind === "template" ? !!template : kind === "text" ? !!text.trim() : /^https:\/\//.test(link.trim());
  return (
    <Dialog open={open} title={contact ? `Message ${contact.firstName ?? contact.phone}` : "Send a WhatsApp message"} onClose={onClose}>
      <div className="space-y-3">
        {!contact && (
          <div>
            <label className="label" htmlFor="wa-send-phone">
              Customer&apos;s WhatsApp number
            </label>
            <input id="wa-send-phone" className="input" type="tel" placeholder="+61412345678" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <p className="mt-1 text-xs text-muted">With the country code. They must have agreed to receive messages from your store.</p>
          </div>
        )}
        <fieldset>
          <legend className="label">Send</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="radio" name="wa-kind" checked={kind === "template"} onChange={() => setKind("template")} /> An approved template
            </label>
            <label className={`flex items-center gap-1.5 ${contact && !windowOpen ? "opacity-60" : ""}`}>
              <input type="radio" name="wa-kind" checked={kind === "text"} disabled={!!contact && !windowOpen} onChange={() => setKind("text")} /> A reply
            </label>
            <label className={`flex items-center gap-1.5 ${contact && !windowOpen ? "opacity-60" : ""}`}>
              <input type="radio" name="wa-kind" checked={kind === "media"} disabled={!!contact && !windowOpen} onChange={() => setKind("media")} /> A photo, document or video
            </label>
          </div>
          <p className="mt-1 text-xs text-muted">
            {contact
              ? windowOpen
                ? "They wrote in the last 24 hours, so you can reply in your own words."
                : "WhatsApp allows free-form replies only within 24 hours of the customer's last message. Use an approved template."
              : "Free-form replies work only within 24 hours of the customer's last message."}
          </p>
        </fieldset>
        {kind === "template" &&
          (templates.error ? (
            <Alert>We couldn&apos;t load your templates.</Alert>
          ) : !approved.length ? (
            <p className="text-sm text-muted">{templates.data ? "No approved template yet." : "Loading templates…"}</p>
          ) : (
            <>
              <select
                className="input"
                aria-label="Template"
                value={ref}
                onChange={(e) => {
                  setRef(e.target.value);
                  setMapping(fitMapping(approved.find((t) => `${t.name}|${t.language}` === e.target.value) ?? null, null, MANUAL_VARIABLES));
                }}
              >
                <option value="">Choose a template…</option>
                {approved.map((t) => (
                  <option key={t.id} value={`${t.name}|${t.language}`}>
                    {t.name} ({t.language}) · {t.category === "MARKETING" ? "Marketing" : "Updates"}
                  </option>
                ))}
              </select>
              {template && <MappingEditor template={template} mapping={mapping} onChange={setMapping} allowed={MANUAL_VARIABLES} headerMediaUrl={media} onHeaderMediaUrl={setMedia} />}
            </>
          ))}
        {kind === "text" && <textarea className="input min-h-28" aria-label="Your reply" maxLength={4096} value={text} onChange={(e) => setText(e.target.value)} />}
        {kind === "media" && (
          <div className="space-y-2">
            <select className="input w-auto" aria-label="Kind of file" value={mediaType} onChange={(e) => setMediaType(e.target.value as typeof mediaType)}>
              <option value="image">Photo (JPEG or PNG)</option>
              <option value="document">Document (PDF)</option>
              <option value="video">Video (MP4)</option>
            </select>
            <input className="input" type="url" aria-label="Public link to the file" placeholder="https://…" value={link} onChange={(e) => setLink(e.target.value)} />
            <input className="input" aria-label="Caption (optional)" placeholder="Caption (optional)" maxLength={1024} value={caption} onChange={(e) => setCaption(e.target.value)} />
            <p className="text-xs text-muted">WhatsApp downloads the file from this link, so it must open without signing in.</p>
          </div>
        )}
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={!ready || (!contact && phone.trim().length < 6) || busy === "send"} onClick={() => void send()}>
            {busy === "send" ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
