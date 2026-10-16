import { ACCESS_MODULE_INFO, modulesOf, ROLE_INFO, type Role } from "@app/shared";
import { escapeHtml } from "@app/shared/email";
import { env } from "../env.js";

/**
 * The link in an invitation email. The token rides in the fragment (`#token=`), which browsers
 * never send to a server: it stays out of CloudFront's and the API's logs and out of any Referer.
 * The invitation page reads it there and posts it.
 */
export const teamInvitationUrl = (token: string) => `${env().APP_URL}/invite#token=${encodeURIComponent(token)}`;

/** What an invitation lets someone see, in words: "Customer details, Product details and Marketing". */
export function accessSummary(access: { role: Role; permissions: readonly string[] }): string {
  if (access.role === "owner" || access.role === "admin") return "everything in the workspace";
  const names = modulesOf(access).map((m) => ACCESS_MODULE_INFO[m].label);
  if (!names.length) return "nothing yet (an owner or admin will choose)";
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function teamInvitationEmail(input: {
  workspace: string;
  inviter: { name: string | null; email: string } | null;
  role: Role;
  permissions: readonly string[];
  message: string | null;
  url: string;
  expiresAt: Date;
  timezone: string;
}) {
  // "October 23, 2026 at 3:00 PM GMT+11", in the inviter's time zone (UTC when theirs is unknown).
  const when = (timeZone: string) =>
    new Intl.DateTimeFormat("en", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" }).format(input.expiresAt);
  let expires: string;
  try {
    expires = when(input.timezone);
  } catch {
    expires = when("UTC");
  }
  const who = input.inviter ? (input.inviter.name ? `${input.inviter.name} (${input.inviter.email})` : input.inviter.email) : "An administrator";
  const role = ROLE_INFO[input.role].label;
  const sees = accessSummary(input);
  // A workspace name is the owner's own text: no line breaks into a mail header.
  const subject = `You've been invited to access a business dashboard: ${input.workspace}`.replace(/[\r\n]+/g, " ");
  const text = [
    "Hello,",
    "",
    `${who} has invited you to access the ${input.workspace} business dashboard on bizinsights, as ${role}.`,
    "",
    `The administrator has granted you access to selected business information: ${sees}.`,
    ...(input.message ? ["", `Their message: "${input.message}"`] : []),
    "",
    "Open the dashboard here:",
    input.url,
    "",
    `Open it to see the dashboard straight away: no password or sign-up needed. The link works once, on the device you open it on, and expires on ${expires}.`,
    ...(input.inviter ? ["", `Questions? Reply to this email to reach ${input.inviter.name ?? input.inviter.email}.`] : []),
    "",
    "If you weren't expecting this invitation, you can safely ignore this email.",
  ].join("\n");
  const e = escapeHtml;
  const html = `<!doctype html><html><body style="margin:0;background:#f7f7f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1b1b18">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e4e4e0;border-radius:12px;padding:28px">
<tr><td>
<p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#2f6f4f">${e(input.workspace)}</p>
<h1 style="margin:0 0 16px;font-size:20px">You've been invited to access a business dashboard</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.5">Hello,</p>
<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${e(who)} has invited you to access the <strong>${e(input.workspace)}</strong> business dashboard on bizinsights, as <strong>${e(role)}</strong>.</p>
<p style="margin:0 0 ${input.message ? "12" : "20"}px;font-size:15px;line-height:1.5">The administrator has granted you access to selected business information: ${e(sees)}.</p>
${input.message ? `<blockquote style="margin:0 0 20px;padding:10px 14px;border-left:3px solid #2f6f4f;background:#f4f8f5;font-size:14px;line-height:1.5;white-space:pre-wrap">${e(input.message)}</blockquote>\n` : ""}<p style="margin:0 0 24px"><a href="${e(input.url)}" style="display:inline-block;background:#2f6f4f;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:8px">Open the dashboard</a></p>
<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#6b6b63">Open it to see the dashboard straight away: no password or sign-up needed. The link works once, on the device you open it on, and expires on ${e(expires)}.</p>
<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#6b6b63">Button not working? Paste this into your browser:<br><span style="word-break:break-all">${e(input.url)}</span></p>
${input.inviter ? `<p style="margin:0;font-size:13px;line-height:1.5;color:#6b6b63">Questions? Reply to this email to reach ${e(input.inviter.name ?? input.inviter.email)}.</p>` : ""}
</td></tr></table>
<p style="font-size:12px;color:#6b6b63">If you weren't expecting this invitation, you can safely ignore this email.</p>
</td></tr></table></body></html>`;
  return { subject, text, html };
}
