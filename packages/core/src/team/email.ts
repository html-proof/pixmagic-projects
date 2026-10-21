import { ACCESS_MODULE_INFO, modulesOf, type Role } from "@app/shared";
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
  const names = accessModuleNames(access);
  if (!names.length) return "nothing yet (an owner or admin will choose)";
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The dashboard areas an invitation opens, by name, for the email's list. */
export function accessModuleNames(access: { role: Role; permissions: readonly string[] }): string[] {
  if (access.role === "owner" || access.role === "admin") return ["Everything in the workspace (view only through the link)"];
  return modulesOf(access).map((m) => ACCESS_MODULE_INFO[m].label);
}

/**
 * The invitation email: a short, plain transactional message with one button, a plain-text part,
 * no images, tracking pixels or tracked links. Built from tables with inline styles (Gmail strips
 * <style> in some views; Outlook renders with Word), the button is a padded table cell that works
 * in both, and the layout narrows to the screen on phones (max-width, no fixed widths).
 */
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
  const who = input.inviter ? (input.inviter.name ? `${input.inviter.name} (${input.inviter.email})` : input.inviter.email) : null;
  const areas = accessModuleNames(input);
  // A workspace name is the owner's own text: no line breaks into a mail header.
  const subject = "You've been invited to view a bizinsights dashboard";
  const store = input.workspace.replace(/[\r\n]+/g, " ");
  const text = [
    "Hello,",
    "",
    `You've been invited to securely view a shared business dashboard through bizinsights: ${store}${who ? `, shared by ${who}` : ""}.`,
    "",
    "The dashboard owner has selected the information you are allowed to view.",
    "",
    "Your access includes:",
    ...(areas.length ? areas.map((a) => `  - ${a}`) : ["  - Nothing yet (the owner will choose)"]),
    ...(input.message ? ["", `Their message: "${input.message}"`] : []),
    "",
    "Open Shared Dashboard:",
    input.url,
    "",
    "No account registration or password is required.",
    "",
    `This invitation expires on ${expires}.`,
    "",
    "The dashboard owner can change or revoke access at any time.",
    ...(input.inviter ? ["", `Questions? Reply to this email to reach ${input.inviter.name ?? input.inviter.email}.`] : []),
    "",
    "If you were not expecting this invitation, you can ignore this email.",
    "",
    "bizinsights Team",
  ].join("\n");
  const e = escapeHtml;
  const p = (body: string, extra = "") => `<p style="margin:0 0 14px;font-size:15px;line-height:22px;color:#1b1b18;${extra}">${body}</p>`;
  const small = (body: string) => `<p style="margin:0 0 10px;font-size:13px;line-height:19px;color:#5f5f57">${body}</p>`;
  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<title>${e(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f1;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">You've been invited to view the ${e(store)} dashboard. No account or password needed.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f1">
<tr><td align="center" style="padding:28px 12px">
<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #e2e2dc;border-radius:12px">
<tr><td style="padding:28px 28px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<p style="margin:0 0 18px;font-size:16px;font-weight:700;color:#1b1b18">bizinsights</p>
<h1 style="margin:0 0 18px;font-size:21px;line-height:28px;font-weight:700;color:#1b1b18">You've been invited to view a business dashboard</h1>
${p("Hello,")}
${p(`You've been invited to securely view a shared business dashboard through bizinsights: <strong>${e(store)}</strong>${who ? `, shared by ${e(who)}` : ""}.`)}
${p("The dashboard owner has selected the information you are allowed to view.")}
<p style="margin:0 0 6px;font-size:15px;line-height:22px;font-weight:700;color:#1b1b18">Your access includes:</p>
<ul style="margin:0 0 16px;padding:0 0 0 20px;font-size:15px;line-height:22px;color:#1b1b18">
${(areas.length ? areas : ["Nothing yet (the owner will choose)"]).map((a) => `<li style="margin:0 0 2px">${e(a)}</li>`).join("\n")}
</ul>
${input.message ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px"><tr><td style="border-left:3px solid #2f6f4f;background:#f2f7f4;padding:10px 14px;font-size:14px;line-height:21px;color:#1b1b18;white-space:pre-wrap">${e(input.message)}</td></tr></table>\n` : ""}<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 22px">
<tr><td align="center" bgcolor="#2f6f4f" style="border-radius:8px;background:#2f6f4f">
<a href="${e(input.url)}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px">Open Shared Dashboard</a>
</td></tr>
</table>
${p("No account registration or password is required.")}
${p(`This invitation expires on <strong>${e(expires)}</strong>.`)}
${p("The dashboard owner can change or revoke access at any time.")}
${small(`Button not working? Copy this link into your browser:<br><a href="${e(input.url)}" style="color:#2f6f4f;word-break:break-all">${e(input.url)}</a>`)}
${small("Anyone with this link can open the shared dashboard, so please don't forward it.")}
${input.inviter ? small(`Questions? Reply to this email to reach ${e(input.inviter.name ?? input.inviter.email)}.`) : ""}
</td></tr>
<tr><td style="padding:8px 28px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
${small("If you were not expecting this invitation, you can ignore this email.")}
<p style="margin:0;font-size:13px;line-height:19px;color:#5f5f57">bizinsights Team</p>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
  return { subject, text, html };
}
