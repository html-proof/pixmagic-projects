import { escapeHtml } from "@app/shared/email";

/**
 * The sign-in emails Amazon Cognito would otherwise send itself: sign-up and email-change codes,
 * password-reset codes, sign-in codes and temporary passwords. Cognito hands each one to the user
 * pool's Custom Email Sender trigger (apps/aws/src/cognitoEmail.ts), which sends it through the
 * app's mail provider from EMAIL_FROM, so they come from bizinsights.io and aren't held to
 * Cognito's own limit of 50 emails a day.
 *
 * Cognito's trigger sources (docs: user-pool-lambda-custom-email-sender) and what each one sends.
 * AccountTakeOverNotification (threat protection, Plus plan) isn't here: the pool is on Essentials.
 */
export const AUTH_EMAIL_KINDS = {
  CustomEmailSender_SignUp: "signup",
  CustomEmailSender_ResendCode: "signup",
  CustomEmailSender_ForgotPassword: "reset",
  CustomEmailSender_UpdateUserAttribute: "change",
  CustomEmailSender_VerifyUserAttribute: "verify",
  CustomEmailSender_Authentication: "signin",
  CustomEmailSender_AdminCreateUser: "invite",
} as const;
export type AuthEmailTrigger = keyof typeof AUTH_EMAIL_KINDS;
export type AuthEmailKind = (typeof AUTH_EMAIL_KINDS)[AuthEmailTrigger];

export const isAuthEmailTrigger = (trigger: string): trigger is AuthEmailTrigger => Object.hasOwn(AUTH_EMAIL_KINDS, trigger);

/**
 * Lifetimes: a sign-up code and a sign-in code last 60 seconds, the API's rule (apps/api/src/emailCode.ts:
 * Cognito itself keeps a confirmation code 24 hours, but every code reaches it through the API,
 * which refuses one older than a minute). The others are Cognito's: attribute codes 24 hours,
 * password-reset codes 1 hour, temporary passwords TemporaryPasswordValidityDays (7,
 * infra/aws/cognito.yaml).
 */
const COPY: Record<AuthEmailKind, { subject: string; heading: string; lead: string; expires: string; ignore: string; preview: string }> = {
  signup: {
    subject: "Your bizinsights verification code",
    heading: "Verify your email address",
    lead: "Your bizinsights verification code is:",
    expires: "This code expires in 1 minute.",
    ignore: "If you did not request this code, you can ignore this email.",
    preview: "Your code to finish creating your bizinsights account.",
  },
  reset: {
    subject: "Reset your bizinsights password",
    heading: "Reset your password",
    lead: "Enter this code in bizinsights to choose a new password:",
    expires: "The code expires in 1 hour.",
    ignore: "If you didn't ask to reset your password, you can ignore this email: your password stays the same.",
    preview: "Your code to choose a new bizinsights password.",
  },
  change: {
    subject: "Confirm your new bizinsights email address",
    heading: "Confirm your new email address",
    lead: "Enter this code in bizinsights to start signing in with this address:",
    expires: "The code expires in 24 hours.",
    ignore: "If you didn't ask to change your email address, you can ignore this email: your account keeps its current address.",
    preview: "Your code to confirm your new email address.",
  },
  verify: {
    subject: "Your bizinsights verification code",
    heading: "Verify your email address",
    lead: "Enter this code in bizinsights to verify this email address:",
    expires: "The code expires in 24 hours.",
    ignore: "If you didn't ask for this, you can ignore this email.",
    preview: "Your code to verify your email address.",
  },
  signin: {
    subject: "Your bizinsights verification code",
    heading: "Verify it's you",
    lead: "Your bizinsights verification code is:",
    expires: "This code expires in 1 minute and works once.",
    ignore: "If you did not request this code, you can ignore this email. Nobody can sign in with your password alone.",
    preview: "Your code to finish signing in to bizinsights.",
  },
  invite: {
    subject: "Your bizinsights account is ready",
    heading: "Your bizinsights account is ready",
    lead: "An account was created for you. Sign in with this email address and this temporary password, then choose your own:",
    expires: "The temporary password expires in 7 days.",
    ignore: "If you weren't expecting this, you can ignore this email.",
    preview: "Sign in to bizinsights with your temporary password.",
  },
};

/** A person's own name for the greeting: one line, no control characters, not too long. */
function greetingName(name: string | null | undefined): string | null {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const clean = (name ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 60) : null;
}

/**
 * The email for one Cognito trigger: a plain-text part and the same in HTML, built like the
 * invitation email (core/team/email.ts): tables with inline styles, no images, tracking or links
 * other than the sign-in page. The code is never in the subject or the preview line, which phones
 * show on a locked screen. Null for a trigger that sends nothing.
 */
export function authEmail(input: { trigger: string; code: string; name?: string | null; email: string; appUrl: string }): { subject: string; text: string; html: string } | null {
  if (!isAuthEmailTrigger(input.trigger)) return null;
  const kind = AUTH_EMAIL_KINDS[input.trigger];
  const copy = COPY[kind];
  const name = greetingName(input.name);
  const hello = name ? `Hello ${name},` : "Hello,";
  const signIn = `${input.appUrl}/login`;
  const invite = kind === "invite";

  const text = [
    hello,
    "",
    copy.lead,
    "",
    ...(invite ? [`  Email: ${input.email}`, `  Temporary password: ${input.code}`] : [`    ${input.code}`]),
    "",
    copy.expires,
    ...(invite ? ["", `Sign in: ${signIn}`] : []),
    "",
    copy.ignore,
    "",
    "bizinsights Team",
  ].join("\n");

  const e = escapeHtml;
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  const mono = "SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
  const p = (body: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:22px;color:#1b1b18">${body}</p>`;
  const small = (body: string) => `<p style="margin:0 0 10px;font-size:13px;line-height:19px;color:#5f5f57">${body}</p>`;
  const box = (body: string, big: boolean) =>
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px"><tr><td style="padding:${big ? "14px 22px" : "10px 16px"};background:#f2f7f4;border:1px solid #cfe3d7;border-radius:10px;font-family:${mono};font-size:${big ? "30px;line-height:36px;letter-spacing:6px" : "18px;line-height:24px;letter-spacing:1px"};font-weight:700;color:#1b1b18;word-break:break-all">${body}</td></tr></table>`;
  const secret = invite
    ? `${p(`Email: <strong>${e(input.email)}</strong>`)}${box(e(input.code), false)}`
    : box(e(input.code), true);
  const button = invite
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 22px">
<tr><td align="center" bgcolor="#2f6f4f" style="border-radius:8px;background:#2f6f4f">
<a href="${e(signIn)}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 24px;font-family:${font};font-size:16px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px">Sign in</a>
</td></tr>
</table>
`
    : "";
  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<title>${e(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f1;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${e(copy.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f1">
<tr><td align="center" style="padding:28px 12px">
<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #e2e2dc;border-radius:12px">
<tr><td style="padding:28px 28px 8px;font-family:${font}">
<p style="margin:0 0 18px;font-size:16px;font-weight:700;color:#1b1b18">bizinsights</p>
<h1 style="margin:0 0 18px;font-size:21px;line-height:28px;font-weight:700;color:#1b1b18">${e(copy.heading)}</h1>
${p(e(hello))}
${p(e(copy.lead))}
${secret}
${p(e(copy.expires))}
${button}${invite ? small(`Button not working? Copy this link into your browser:<br><a href="${e(signIn)}" style="color:#2f6f4f;word-break:break-all">${e(signIn)}</a>`) : small("Never share this code: bizinsights will never ask you for it.")}
</td></tr>
<tr><td style="padding:8px 28px 24px;font-family:${font}">
${small(e(copy.ignore))}
<p style="margin:0;font-size:13px;line-height:19px;color:#5f5f57">bizinsights Team</p>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
  return { subject: copy.subject, text, html };
}
