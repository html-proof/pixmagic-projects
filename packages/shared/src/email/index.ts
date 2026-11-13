// Email addresses as the app's own mail uses them (sign-in codes, invitations, alerts): validation,
// normalization, masking, and text made safe for an HTML email. `@app/shared/email`.
export * from "./address";

/** Text made safe to place in HTML (an email's body, an attribute value). */
export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
