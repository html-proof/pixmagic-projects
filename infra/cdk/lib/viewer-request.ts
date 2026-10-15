/**
 * The CloudFront viewer-request function (cloudfront-js-2.0), as source text.
 *
 * Every request: the viewer's address and host go to the origin in headers of our own, overwriting
 * anything the client sent (the function only believes them on requests that carry the origin secret).
 *
 * With an address of its own (`canonicalHost`), page requests (GET, HEAD) that arrive on any other
 * name CloudFront answers on (www, the *.cloudfront.net address) are sent there with a 301: sessions,
 * the CSRF check and OAuth callbacks all expect one origin (APP_URL). The path and the query string
 * go along exactly as received, so a Shopify launch's HMAC still verifies. Other methods (webhooks,
 * pixel events, API-key clients) are served where they arrive: they don't follow redirects.
 */
export function viewerRequestCode(canonicalHost?: string): string {
  return [
    `var CANONICAL = ${JSON.stringify(canonicalHost ?? "")};`,
    "function query(q) {",
    "  var out = [];",
    "  for (var k in q) {",
    "    var vals = q[k].multiValue ? q[k].multiValue : [q[k]];",
    "    for (var i = 0; i < vals.length; i++) out.push(vals[i].value === '' ? k : k + '=' + vals[i].value);",
    "  }",
    "  return out.length ? '?' + out.join('&') : '';",
    "}",
    "function handler(event) {",
    "  var r = event.request;",
    "  var host = r.headers.host ? r.headers.host.value.toLowerCase() : '';",
    "  if (CANONICAL && host !== CANONICAL && (r.method === 'GET' || r.method === 'HEAD')) {",
    "    return {",
    "      statusCode: 301,",
    "      statusDescription: 'Moved Permanently',",
    "      headers: { location: { value: 'https://' + CANONICAL + r.uri + query(r.querystring) }, 'cache-control': { value: 'max-age=3600' } },",
    "    };",
    "  }",
    "  r.headers['x-insights-viewer-ip'] = { value: event.viewer.ip };",
    "  r.headers['x-insights-viewer-host'] = { value: host };",
    "  return r;",
    "}",
  ].join("\n");
}
