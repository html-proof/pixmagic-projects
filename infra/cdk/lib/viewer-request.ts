import { CLOUDFLARE_CLIENT_IP_HEADER, CLOUDFLARE_IPV4, CLOUDFLARE_IPV6 } from "./cloudflare.js";

/**
 * The CloudFront viewer-request function (cloudfront-js-2.0), as source text.
 *
 * Every request: the viewer's address and host go to the origin in headers of our own, overwriting
 * anything the client sent (the function only believes them on requests that carry the origin secret).
 * When the viewer is Cloudflare's proxy (an address in its ranges, cloudflare.ts), the address passed
 * on is the client's, from `CF-Connecting-IP`; from anywhere else that header is ignored.
 *
 * With an address of its own (`canonicalHost`), page requests (GET, HEAD) that arrive on any other
 * name CloudFront answers on (www, the *.cloudfront.net address) are sent there with a 301: sessions,
 * the CSRF check and OAuth callbacks all expect one origin (APP_URL). The path and every query
 * parameter go along unchanged. Their order may not: CloudFront hands the function the query as an
 * object, not as text. A Shopify launch's HMAC still verifies, since it is computed over the
 * parameters sorted by name (verifyShopifyQueryHmac). Other methods (webhooks,
 * pixel events, API-key clients) are served where they arrive: they don't follow redirects.
 */
export function viewerRequestCode(canonicalHost?: string): string {
  return [
    `var CANONICAL = ${JSON.stringify(canonicalHost ?? "")};`,
    // [first 32 bits of the network, prefix length]: every Cloudflare range fits in 32 bits.
    `var CF4 = ${JSON.stringify(CLOUDFLARE_IPV4.map((cidr) => network(cidr, (a) => a.split(".").reduce((n, p) => n * 256 + Number(p), 0))))};`,
    `var CF6 = ${JSON.stringify(CLOUDFLARE_IPV6.map((cidr) => network(cidr, (a) => parseInt(a.split(":")[0]!, 16) * 65536 + parseInt(a.split(":")[1] || "0", 16))))};`,
    "function fromCloudflare(ip) {",
    "  var head, list;",
    "  if (ip.indexOf(':') < 0) {",
    "    var p = ip.split('.');",
    "    if (p.length !== 4) return false;",
    "    head = 0;",
    "    for (var i = 0; i < 4; i++) head = head * 256 + parseInt(p[i], 10);",
    "    list = CF4;",
    "  } else {",
    "    var g = ip.split('::')[0].split(':');",
    "    head = parseInt(g[0] || '0', 16) * 65536 + parseInt(g[1] || '0', 16);",
    "    list = CF6;",
    "  }",
    "  if (!(head >= 0)) return false;",
    "  for (var j = 0; j < list.length; j++) {",
    "    var size = Math.pow(2, 32 - list[j][1]);",
    "    if (Math.floor(head / size) === Math.floor(list[j][0] / size)) return true;",
    "  }",
    "  return false;",
    "}",
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
    "  var ip = event.viewer.ip;",
    `  var client = r.headers['${CLOUDFLARE_CLIENT_IP_HEADER}'];`,
    "  if (client && /^[0-9A-Fa-f:.]{2,45}$/.test(client.value) && fromCloudflare(ip)) ip = client.value;",
    "  r.headers['x-insights-viewer-ip'] = { value: ip };",
    "  r.headers['x-insights-viewer-host'] = { value: host };",
    "  return r;",
    "}",
  ].join("\n");
}

/** A CIDR's first 32 bits as a number (`head` reads them from the address), with its prefix length. */
function network(cidr: string, head: (address: string) => number): [number, number] {
  const [address, bits] = cidr.split("/");
  if (Number(bits) > 32) throw new Error(`${cidr}: the viewer function compares 32 bits at most`);
  return [head(address!), Number(bits)];
}
