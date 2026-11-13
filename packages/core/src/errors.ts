/**
 * A rule the person using the app broke, or a step they have to take first. The API answers it
 * with `status` and `{ "error": code, "message": message }` (plus `detail` when there is one), so
 * the message is written for them. Anything else thrown is a bug or an outage and becomes a
 * generic 500. Each module throws its own subclass (StaffError, WhatsappError), so
 * logs say which.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    /** Extra machine-readable detail (e.g. the blocking issues of a payroll). */
    public detail?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/**
 * A provider's own error text (Meta, Google), fit to show the merchant whose request it answers:
 * one line, links and token-like strings taken out, at most 200 characters. Provider text never
 * reaches a response any other way: it can carry ids and internals the merchant has no use for.
 */
export function providerDetail(text: string | null | undefined): string {
  const clean = (text ?? "")
    .replace(/https?:\/\/\S+/g, "[link]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[…]")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 200 ? `${clean.slice(0, 199)}…` : clean;
}
