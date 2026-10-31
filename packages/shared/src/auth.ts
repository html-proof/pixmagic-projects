// Account sign-up and password rules, checked by the API (authoritative) and by the forms (as you
// type). The Cognito user pool's own password policy (infra/aws/cognito.yaml) is the same minimum,
// so whatever passes here is accepted there. Employees' passwords follow the stricter rules in
// staff/password.ts.
//
// Imported by the UI through `@app/shared/auth`: relative imports stay extensionless.

export const ACCOUNT_PASSWORD_MIN = 8;
/** Cognito's own limit. */
export const ACCOUNT_PASSWORD_MAX = 256;
/** PATCH /me's limit on a display name. */
export const DISPLAY_NAME_MAX = 80;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isEmailAddress = (email: string) => email.length <= 254 && EMAIL_RE.test(email.trim());

/** What is wrong with a new account password, in plain words; null when it is acceptable. */
export function accountPasswordProblem(password: string): string | null {
  if (password.length < ACCOUNT_PASSWORD_MIN) return `Use at least ${ACCOUNT_PASSWORD_MIN} characters for your password.`;
  if (password.length > ACCOUNT_PASSWORD_MAX) return `Use at most ${ACCOUNT_PASSWORD_MAX} characters for your password.`;
  // Cognito refuses leading or trailing spaces.
  if (password.trim() !== password) return "Your password can't start or end with a space.";
  return null;
}

/** Codes Cognito emails (sign-up confirmation, password reset, email change): six digits. */
export const EMAIL_CODE_RE = /^\d{6}$/;

/**
 * Seconds a sign-up or sign-in code lives from the moment it is issued: the API enforces it
 * (apps/api/src/emailCode.ts) and the email states it (core/mail/authEmails.ts).
 */
export const EMAIL_CODE_TTL_S = 60;

/**
 * The 6-digit code in what someone copied: the code, a line of the email or all of it, or the code
 * split in two ("482 913", "482-913"). Longer numbers (a phone number, an order id) are not codes.
 * Null when there is none.
 */
export function codeInText(text: string): string | null {
  const whole = /(?<!\d)\d{6}(?!\d)/.exec(text);
  if (whole) return whole[0];
  const split = /(?<![\d-])(\d{3})[ \u00a0-](\d{3})(?![\d-])/.exec(text);
  return split ? split[1]! + split[2]! : null;
}
