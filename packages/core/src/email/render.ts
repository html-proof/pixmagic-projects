/**
 * Turning a template and an event into the email's subject, HTML and text, the same way for
 * previews, test sends and real sends. Marketing email always ends with an unsubscribe link and the
 * business's postal address, whether or not the template has them.
 */
import { systemDb } from "@app/db";
import { escapeHtml, htmlToText, renderTemplate, sanitizeHtml, type EventData } from "@app/shared/email";

export interface TemplateParts {
  subject: string;
  html: string;
  text: string;
  category: string;
}

export interface Business {
  name: string;
  address: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** {{business.*}} for a workspace: its email settings, or the workspace's own name. */
export async function businessInfo(workspaceId: string): Promise<Business> {
  const [settings, ws] = await Promise.all([
    systemDb.emailSettings.findUnique({ where: { workspaceId } }),
    systemDb.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
  ]);
  return { name: settings?.businessName || ws?.name || "Our team", address: settings?.businessAddress ?? null };
}

export function renderEmail(t: TemplateParts, input: { data: EventData; business: Business; recipient: string; unsubscribeUrl?: string | null }): RenderedEmail {
  const marketing = t.category === "marketing";
  const data: EventData = {
    ...input.data,
    business: { name: input.business.name, address: input.business.address ?? "" },
    recipient: { email: input.recipient },
    ...(marketing && input.unsubscribeUrl ? { unsubscribe_url: input.unsubscribeUrl } : {}),
  };
  const subject = renderTemplate(t.subject, data, "subject") || "(no subject)";
  let html = t.html.trim() ? sanitizeHtml(renderTemplate(t.html, data, "html")) : "";
  let text = t.text.trim() ? renderTemplate(t.text, data, "text") : "";
  if (!text && html) text = htmlToText(html);
  if (!html) html = `<div style="font-family:Arial,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</div>`;
  if (marketing) {
    const url = input.unsubscribeUrl ?? "";
    if (!t.html.includes("unsubscribe_url")) {
      html += sanitizeHtml(
        `<p style="margin-top:24px;font-size:12px;color:#6b7280">You're receiving this because you agreed to hear from ${escapeHtml(input.business.name)}.` +
          (url ? ` <a href="${escapeHtml(url)}">Unsubscribe</a>.` : "") +
          (input.business.address ? `<br>${escapeHtml(input.business.address)}` : "") +
          "</p>",
      );
    }
    if (!t.text.includes("unsubscribe_url")) {
      text += `\n\n--\nYou're receiving this because you agreed to hear from ${input.business.name}.${url ? `\nUnsubscribe: ${url}` : ""}${input.business.address ? `\n${input.business.address}` : ""}`;
    }
  }
  return { subject, html, text };
}
