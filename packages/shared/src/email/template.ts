// Email templates: `{{ customer.first_name }}` placeholders, with an optional fallback:
// `{{ customer.first_name | default: "there" }}`. That is the whole language: no helpers, no
// logic, no partials, nothing that runs. A placeholder names a dotted path into the event's data
// (readPath only follows the data's own properties) and is replaced by its text, HTML-escaped in
// HTML. Which paths a template may use is checked when it is saved (isAllowedVariable).

import { readPath } from "./events";

export type TemplateToken = { kind: "text"; value: string } | { kind: "var"; path: string; fallback: string | null };

const PATH = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*){0,4}$/;
const EXPR = /^([a-z0-9_.]+)\s*(?:\|\s*default\s*:\s*"([^"\\]{0,200})"\s*)?$/;

export const TEMPLATE_LIMITS = { subject: 250, html: 200_000, text: 100_000, placeholders: 200 } as const;

/** Split a template into text and placeholders, with every problem found on the way. */
export function parseTemplate(src: string): { tokens: TemplateToken[]; errors: string[] } {
  const tokens: TemplateToken[] = [];
  const errors: string[] = [];
  let i = 0;
  let count = 0;
  while (i < src.length) {
    const open = src.indexOf("{{", i);
    const strayClose = src.indexOf("}}", i);
    if (strayClose !== -1 && (open === -1 || strayClose < open)) {
      errors.push("A closing }} has no opening {{.");
      tokens.push({ kind: "text", value: src.slice(i, strayClose + 2) });
      i = strayClose + 2;
      continue;
    }
    if (open === -1) {
      tokens.push({ kind: "text", value: src.slice(i) });
      break;
    }
    if (open > i) tokens.push({ kind: "text", value: src.slice(i, open) });
    const close = src.indexOf("}}", open + 2);
    if (close === -1) {
      errors.push("A {{ is never closed with }}.");
      tokens.push({ kind: "text", value: src.slice(open) });
      break;
    }
    const inner = src.slice(open + 2, close).trim();
    const m = EXPR.exec(inner);
    if (!m || !PATH.test(m[1]!) || /(^|\.)(__proto__|constructor|prototype)(\.|$)/.test(m[1]!)) {
      errors.push(`"{{${inner.slice(0, 60)}}}" isn't a valid placeholder. Use {{ name }} or {{ name | default: "text" }}.`);
      tokens.push({ kind: "text", value: "" });
    } else {
      tokens.push({ kind: "var", path: m[1]!, fallback: m[2] ?? null });
      if (++count > TEMPLATE_LIMITS.placeholders) {
        errors.push(`A template can use at most ${TEMPLATE_LIMITS.placeholders} placeholders.`);
        break;
      }
    }
    i = close + 2;
  }
  return { tokens, errors: [...new Set(errors)] };
}

/** The variable paths a template uses. */
export function placeholdersIn(src: string): string[] {
  return [...new Set(parseTemplate(src).tokens.flatMap((t) => (t.kind === "var" ? [t.path] : [])))];
}

/** Problems with a template's syntax and variables (`allowed` says whether a path may be used). */
export function templateProblems(parts: { subject: string; html: string; text: string }, allowed: (path: string) => boolean): string[] {
  const problems: string[] = [];
  for (const [label, src] of [["Subject", parts.subject], ["HTML", parts.html], ["Plain text", parts.text]] as const) {
    const { tokens, errors } = parseTemplate(src);
    for (const e of errors) problems.push(`${label}: ${e}`);
    for (const t of tokens) if (t.kind === "var" && !allowed(t.path)) problems.push(`${label}: {{${t.path}}} isn't available for this template's event.`);
  }
  if (/[\r\n]/.test(parts.subject)) problems.push("Subject: must be a single line.");
  return [...new Set(problems)].slice(0, 20);
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A value as text: numbers with cents when they have a fraction, lists comma separated, yes/no for booleans. */
export function formatValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v.length ? v : null;
  if (typeof v === "number") return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : null;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) {
    const items = v.map(formatValue).filter((x): x is string => !!x);
    return items.length ? items.slice(0, 50).join(", ") : null;
  }
  return null;
}

export type RenderMode = "html" | "text" | "subject";

/**
 * Fill a template in. A missing value becomes the placeholder's fallback, or nothing. In HTML every
 * value is escaped (the caller sanitizes the result again, so a value can't smuggle in a link
 * scheme either); in a subject, line breaks become spaces so a value can't add a header.
 */
export function renderTemplate(src: string, data: unknown, mode: RenderMode): string {
  const { tokens } = parseTemplate(src);
  let out = "";
  for (const t of tokens) {
    if (t.kind === "text") {
      out += t.value;
      continue;
    }
    const value = formatValue(readPath(data, t.path)) ?? t.fallback ?? "";
    out += mode === "html" ? escapeHtml(value) : value;
  }
  if (mode === "subject") {
    // eslint-disable-next-line no-control-regex -- a subject must not carry control characters
    out = out.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim();
    if (out.length > TEMPLATE_LIMITS.subject) out = `${out.slice(0, TEMPLATE_LIMITS.subject - 1)}…`;
  }
  return out;
}

/** A plain-text version of an HTML body, for templates written without one. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, "").trim();
      return text && text !== href ? `${text} (${href})` : href;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
