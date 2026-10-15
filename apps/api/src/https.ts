/** Local development hosts: the only ones served over plain http. */
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|.+\.localhost)$/;

/**
 * HTTPS only, for every request the Worker answers (pages and API alike). workers.dev also answers
 * plain http:// and has no "Always Use HTTPS" switch, so without this a sign-in could send its
 * Firebase ID token, and the page itself, unencrypted. A GET or HEAD is redirected; anything else
 * is refused, because its body has already crossed the network in clear and must not be acted on.
 * Browsers then stay on https for a year (Strict-Transport-Security). Null: carry on.
 */
export function requireHttps(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.protocol !== "http:" || LOCAL_HOST.test(url.hostname)) return null;
  if (request.method === "GET" || request.method === "HEAD") {
    url.protocol = "https:";
    return Response.redirect(url.toString(), 301);
  }
  return Response.json({ error: "https_required", message: "Use https://" }, { status: 403 });
}
