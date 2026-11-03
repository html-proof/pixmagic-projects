import { EMAIL_CODE_TTL_S } from "@app/shared/auth";
import { escapeHtml } from "@app/shared/email";
import { signatureFor, type EmailPurpose, type SenderSettings } from "./senders.js";

/**
 * The sign-in emails Amazon Cognito would otherwise send itself: sign-up and email-change codes,
 * password-reset codes, sign-in codes and temporary passwords. Cognito hands each one to the user
 * pool's Custom Email Sender trigger (apps/aws/src/cognitoEmail.ts), which sends it through the
 * app's mail provider from the support sender (core/mail/senders.ts), so they come from
 * bizinsights.io and aren't held to Cognito's own limit of 50 emails a day.
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
/** Codes the API emails of its own accord, which no Cognito trigger names: deleting the account or a workspace (accountDeletionEmail, workspaceDeletionEmail). */
type CodeEmailKind = AuthEmailKind | "delete" | "delete_workspace";

/** What each one is for, which picks its sender: all of them the support sender. */
const PURPOSE: Record<CodeEmailKind, EmailPurpose> = {
  signup: "signup_code",
  reset: "password_reset_code",
  change: "verification_code",
  verify: "verification_code",
  signin: "login_code",
  invite: "temporary_password",
  delete: "account_deletion_code",
  delete_workspace: "workspace_deletion_code",
};

export const isAuthEmailTrigger = (trigger: string): trigger is AuthEmailTrigger => Object.hasOwn(AUTH_EMAIL_KINDS, trigger);

/**
 * Lifetimes: a sign-up code, a sign-in code and an account-deletion code last EMAIL_CODE_TTL_S (60
 * seconds), the API's rule (apps/api/src/emailCode.ts: Cognito itself keeps a confirmation code 24
 * hours, but every code reaches it through the API, which refuses one older than that). The others
 * are Cognito's: attribute codes 24 hours, password-reset codes 1 hour, temporary passwords
 * TemporaryPasswordValidityDays (7, infra/aws/cognito.yaml).
 */
const minute = `${EMAIL_CODE_TTL_S} seconds`;
const COPY: Record<CodeEmailKind, { subject: string; heading: string; lead: string; expires: string; ignore: string; preview: string }> = {
  signup: {
    subject: "Your bizinsights verification code",
    heading: "Verify your email address",
    lead: "Use the verification code below to finish creating your bizinsights account.",
    expires: `This code expires in ${minute}.`,
    ignore: "If you did not request this code, you can safely ignore this email.",
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
    heading: "Your bizinsights verification code",
    lead: "Use the verification code below to continue signing in to your bizinsights account.",
    expires: `This code expires in ${minute} and works once.`,
    ignore: "If you did not request this code, you can safely ignore this email. Nobody can sign in with your password alone.",
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
  delete: {
    subject: "Confirm deleting your bizinsights account",
    heading: "Confirm deleting your account",
    lead: "Use the code below to confirm that you want to permanently delete your bizinsights account.",
    expires: `This code expires in ${minute} and works once.`,
    ignore: "If you didn't ask to delete your account, someone may be signed in to it: don't share this code, choose Sign out everywhere in Settings → Security, and change your password.",
    preview: "Your code to confirm deleting your bizinsights account.",
  },
  delete_workspace: {
    subject: "Confirm deleting your bizinsights workspace",
    heading: "Confirm deleting a workspace",
    // Naming the workspace when the caller gives its name (codeEmail).
    lead: "Use the code below to confirm that you want to permanently delete this bizinsights workspace, its stores' data and everything its team set up.",
    expires: `This code expires in ${minute} and works once.`,
    ignore: "If you didn't ask to delete this workspace, someone may be signed in to your account: don't share this code, choose Sign out everywhere in Settings → Security, and change your password.",
    preview: "Your code to confirm deleting a bizinsights workspace.",
  },
};

/**
 * How to copy the code. A mail app runs no scripts, so the email can't hold a working Copy button,
 * and a link that carried the code would put it in a URL (browser history, logs). The code is one
 * run of digits instead, which a double-click or a long press selects whole; mail apps that offer
 * their own "Copy code" find it on its own line.
 */
const COPY_HINT = "To copy the code, double-click it, or press and hold it on a phone.";

/** A name someone typed (theirs for the greeting, a workspace's): one line, no control characters, at most `max` long. */
function oneLine(name: string | null | undefined, max = 60): string | null {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const clean = (name ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
}

/**
 * The email for one Cognito trigger: a plain-text part and the same in HTML, built like the
 * invitation email (core/team/email.ts): tables with inline styles, no images, tracking or links
 * other than the sign-in page. The code is never in the subject or the preview line, which phones
 * show on a locked screen. `purpose` goes to the mailer (MailOptions.purpose), which sends it from
 * the support sender. `senders` (env() in the app) signs it off as that sender, with the support
 * address; without it, "bizinsights Team". Null for a trigger that sends nothing.
 */
export function authEmail(input: { trigger: string } & CodeEmailInput): CodeEmail | null {
  if (!isAuthEmailTrigger(input.trigger)) return null;
  return codeEmail(AUTH_EMAIL_KINDS[input.trigger], input);
}

/** The code that confirms deleting the account (apps/api/src/routes/account.ts), built like the others. */
export const accountDeletionEmail = (input: CodeEmailInput): CodeEmail => codeEmail("delete", input);

/** The code that confirms deleting the workspace `workspace` names (apps/api/src/routes/workspaces.ts). */
export const workspaceDeletionEmail = (input: CodeEmailInput & { workspace: string }): CodeEmail => codeEmail("delete_workspace", input);

interface CodeEmailInput {
  code: string;
  name?: string | null;
  email: string;
  appUrl: string;
  senders?: SenderSettings;
  /** The name of the workspace a workspace-deletion code is for. */
  workspace?: string;
}
type CodeEmail = { subject: string; text: string; html: string; purpose: EmailPurpose };

function codeEmail(kind: CodeEmailKind, input: CodeEmailInput): CodeEmail {
  const workspace = kind === "delete_workspace" ? oneLine(input.workspace, 80) : null;
  const copy = workspace
    ? { ...COPY[kind], lead: `Use the code below to confirm that you want to permanently delete the workspace "${workspace}", its stores' data and everything its team set up in bizinsights.` }
    : COPY[kind];
  const purpose = PURPOSE[kind];
  const name = oneLine(input.name);
  const hello = name ? `Hello ${name},` : "Hello,";
  const signIn = `${input.appUrl}/login`;
  const invite = kind === "invite";
  const sig = input.senders ? signatureFor(purpose, input.senders) : null;
  // The support sender's own address is already in the signature.
  const support = sig?.support && sig.support !== sig.email ? sig.support : null;

  const text = [
    hello,
    "",
    copy.lead,
    "",
    ...(invite ? [`  Email: ${input.email}`, `  Temporary password: ${input.code}`] : [`    ${input.code}`, "", COPY_HINT]),
    "",
    copy.expires,
    ...(invite ? ["", `Sign in: ${signIn}`] : []),
    "",
    copy.ignore,
    ...(support ? ["", `Questions? Contact ${support}.`] : []),
    "",
    ...(sig ? ["Regards,", sig.name, ...(sig.email ? [sig.email] : [])] : ["bizinsights Team"]),
  ].join("\n");

  const e = escapeHtml;
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  const mono = "SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
  const p = (body: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:22px;color:#1b1b18">${body}</p>`;
  const small = (body: string) => `<p style="margin:0 0 10px;font-size:13px;line-height:19px;color:#5f5f57">${body}</p>`;
  // user-select:all: where the mail app honours it, one tap or click selects the whole code.
  const box = (body: string, big: boolean, label: string) =>
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 ${big ? "10px" : "18px"}"><tr><td aria-label="${e(label)}" style="padding:${big ? "14px 22px" : "10px 16px"};background:#f2f7f4;border:1px solid #cfe3d7;border-radius:10px;font-family:${mono};font-size:${big ? "30px;line-height:36px;letter-spacing:6px" : "18px;line-height:24px;letter-spacing:1px"};font-weight:700;color:#1b1b18;word-break:break-all;-webkit-user-select:all;user-select:all">${body}</td></tr></table>`;
  const secret = invite
    ? `${p(`Email: <strong>${e(input.email)}</strong>`)}${box(e(input.code), false, "Temporary password")}`
    : `${box(e(input.code), true, "Verification code")}${small(e(COPY_HINT))}`;
  const button = invite
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 22px">
<tr><td align="center" bgcolor="#2f6f4f" style="border-radius:8px;background:#2f6f4f">
<a href="${e(signIn)}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 24px;font-family:${font};font-size:16px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px">Sign in</a>
</td></tr>
</table>
`
    : "";
  const mailto = (addr: string) => `<a href="mailto:${e(addr)}" style="color:#2f6f4f">${e(addr)}</a>`;
  const signOff = sig
    ? `<p style="margin:0;font-size:13px;line-height:19px;color:#5f5f57">Regards,<br>${e(sig.name)}${sig.email ? `<br>${mailto(sig.email)}` : ""}</p>`
    : `<p style="margin:0;font-size:13px;line-height:19px;color:#5f5f57">bizinsights Team</p>`;
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
${support ? small(`Questions? Contact ${mailto(support)}.`) : ""}
${signOff}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
  return { subject: copy.subject, text, html, purpose };
}
