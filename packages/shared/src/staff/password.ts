// Password rules for employee accounts, checked by the API (authoritative) and by the form (as
// you type). The password itself goes to Firebase Authentication, which stores only a salted
// scrypt hash; Insights never stores or logs it.
//
// Imported by the UI through `@app/shared/staff`: relative imports stay extensionless.

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/** The most guessed passwords that would otherwise pass the length rule. */
const COMMON = new Set([
  "password1234",
  "password12345",
  "password123456",
  "passw0rd1234",
  "qwerty123456",
  "qwertyuiop12",
  "123456789012",
  "1234567890ab",
  "abc123456789",
  "iloveyou1234",
  "letmein12345",
  "welcome12345",
  "welcome@1234",
  "admin1234567",
  "changeme1234",
  "p@ssw0rd1234",
  "password@123",
  "Password@123",
  "Password1234",
  "Password123!",
]);

export interface PasswordContext {
  email?: string | null;
  name?: string | null;
}

/** Each rule a password breaks, in plain words; empty when it is acceptable. */
export function passwordProblems(password: string, ctx: PasswordContext = {}): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN) problems.push(`Use at least ${PASSWORD_MIN} characters.`);
  if (password.length > PASSWORD_MAX) problems.push(`Use at most ${PASSWORD_MAX} characters.`);
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (kinds < 3) problems.push("Mix at least three of: lowercase letters, capital letters, numbers and symbols.");
  const lower = password.toLowerCase();
  if (COMMON.has(password) || COMMON.has(lower)) problems.push("That password is too common. Choose something less predictable.");
  if (/(.)\1{3,}/.test(password)) problems.push("Avoid repeating the same character four or more times.");
  const personal = [ctx.email?.split("@")[0], ...(ctx.name ?? "").split(/\s+/)]
    .map((s) => (s ?? "").toLowerCase())
    .filter((s) => s.length >= 4);
  if (personal.some((p) => lower.includes(p))) problems.push("Don't use your name or email address in your password.");
  return problems;
}

/** A rough strength for the meter under the field: 0 (too weak) to 4 (strong). */
export function passwordStrength(password: string, ctx: PasswordContext = {}): 0 | 1 | 2 | 3 | 4 {
  if (!password) return 0;
  if (passwordProblems(password, ctx).length) return password.length >= 8 ? 1 : 0;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (password.length >= 16 && kinds === 4) return 4;
  if (password.length >= 14 || kinds === 4) return 3;
  return 2;
}
