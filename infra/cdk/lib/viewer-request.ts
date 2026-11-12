import { CLOUDFLARE_CLIENT_IP_HEADER, CLOUDFLARE_IPV4, CLOUDFLARE_IPV6 } from "./cloudflare.js";

/**
 * The CloudFront viewer-request function (cloudfront-js-2.0), as source text.
 *
 * Every request: the viewer's address and host go to the origin in headers of our own, overwriting
 * anything the client sent (the function only believes them on requests that carry the origin secret).
 * When the viewer is Cloudflare's proxy (an address in its ranges, cloudflare.ts), the address passed
 * on is the client's, from `CF-Connecting-IP`; from anywhere else that header is ignored. Where the
 * client is goes along the same way, as "country|region|city" (each part URI-encoded): from
 * Cloudflare's visitor-location headers (`CF-IPCountry`, and `CF-Region` / `CF-IPCity` when the zone
 * adds them) behind its proxy, otherwise from CloudFront's own `CloudFront-Viewer-*` headers.
 *
 * With an address of its own (`canonicalHost`), page requests (GET, HEAD) that arrive on any other
 * name CloudFront answers on (www, the *.cloudfront.net address) are sent there with a 301: sessions,
 * the CSRF check and OAuth callbacks all expect one origin (APP_URL). The path and every query
 * parameter go along unchanged. Their order may not: CloudFront hands the function the query as an
 * object, not as text. A Shopify launch's HMAC still verifies, since it is computed over the
 * parameters sorted by name (verifyShopifyQueryHmac). Other methods (webhooks,
 * pixel events, API-key clients) are served where they arrive: they don't follow redirects.
 *
 * With an origin lock (`lock`, config.ts `domain.originLock`), the function knows the secret
 * Cloudflare's proxy adds to every request it passes on (ORIGIN_LOCK_HEADER, a Transform Rule in the
 * zone). The header is taken off before the origin either way, so the app never sees or logs it.
 * `GET /edge-lock` (ORIGIN_LOCK_PROBE) answers here, 204 with the secret and 403 without: asked
 * through the domain it says whether Cloudflare sends the header, without a function invocation.
 * While `enforce` is false that is all (every request is served as before); once true, a request
 * without the secret gets 403, so nobody can skip Cloudflare by calling the cloudfront.net name, or
 * CloudFront's addresses with the domain as Host. The redirect above still comes first: it gives
 * nothing away and costs the origin nothing. Cloudflare's address ranges are not required as well:
 * the list is kept by hand (cloudflare.ts), and a range Cloudflare added would turn into 403s for
 * the clients behind it, where today it only blurs a rate limit.
 */
export function viewerRequestCode(canonicalHost?: string, lock?: OriginLock): string {
  if (lock && !canonicalHost) throw new Error("An origin lock needs the app's own domain: without one, clients call CloudFront's name directly");
  if (lock && !/^[\w.:-]+$/.test(lock.read)) throw new Error(`originLockRead "${lock.read}": letters, digits, . : - and _ only (it goes into the function's source)`);
  return [
    // CloudFormation reads the secret again only when this source changes: this line is how (config.ts originLockRead).
    ...(lock ? [`// The origin lock's secret as read on ${lock.read}`] : []),
    `var CANONICAL = ${JSON.stringify(canonicalHost ?? "")};`,
    // "" without a lock. With one, CloudFormation puts the value here when it deploys (app-stack.ts).
    `var LOCK = ${JSON.stringify(lock?.secret ?? "")};`,
    `var ENFORCE = ${lock?.enforce === true};`,
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
    "function hv(r, n) {",
    "  return r.headers[n] ? r.headers[n].value : '';",
    "}",
    "function query(q) {",
    "  var out = [];",
    "  for (var k in q) {",
    "    var vals = q[k].multiValue ? q[k].multiValue : [q[k]];",
    "    for (var i = 0; i < vals.length; i++) out.push(vals[i].value === '' ? k : k + '=' + vals[i].value);",
    "  }",
    "  return out.length ? '?' + out.join('&') : '';",
    "}",
    // Every character compared, whatever matched so far: the time taken says nothing about the secret.
    "function same(a, b) {",
    "  if (a.length !== b.length) return false;",
    "  var d = 0;",
    "  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);",
    "  return d === 0;",
    "}",
    "function refused() {",
    "  return { statusCode: 403, statusDescription: 'Forbidden', headers: { 'cache-control': { value: 'no-store' }, 'content-type': { value: 'text/plain' } }, body: 'Forbidden' };",
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
    "  if (LOCK) {",
    `    var sent = r.headers['${ORIGIN_LOCK_HEADER}'];`,
    "    var unlocked = !!sent && same(sent.value, LOCK);",
    `    delete r.headers['${ORIGIN_LOCK_HEADER}'];`,
    `    if (r.uri === '${ORIGIN_LOCK_PROBE}') return unlocked ? { statusCode: 204, statusDescription: 'No Content', headers: { 'cache-control': { value: 'no-store' } } } : refused();`,
    "    if (ENFORCE && !unlocked) return refused();",
    "  }",
    "  var ip = event.viewer.ip;",
    "  var viaCf = fromCloudflare(ip);",
    `  var client = r.headers['${CLOUDFLARE_CLIENT_IP_HEADER}'];`,
    "  if (client && /^[0-9A-Fa-f:.]{2,45}$/.test(client.value) && viaCf) ip = client.value;",
    "  r.headers['x-insights-viewer-ip'] = { value: ip };",
    "  r.headers['x-insights-viewer-host'] = { value: host };",
    "  var geo = viaCf",
    "    ? [hv(r, 'cf-ipcountry'), hv(r, 'cf-region'), hv(r, 'cf-ipcity')]",
    "    : [hv(r, 'cloudfront-viewer-country'), hv(r, 'cloudfront-viewer-country-region-name'), hv(r, 'cloudfront-viewer-city')];",
    "  if (geo[0] || geo[1] || geo[2]) r.headers['x-insights-viewer-geo'] = { value: geo.map(encodeURIComponent).join('|') };",
    "  else delete r.headers['x-insights-viewer-geo'];",
    "  return r;",
    "}",
  ].join("\n");
}

/** The request header Cloudflare's proxy carries the origin lock's secret in (a Transform Rule in the zone). */
export const ORIGIN_LOCK_HEADER = "x-origin-lock";

/** Answered by the function itself: 204 when the request carried the secret, 403 when it didn't. */
export const ORIGIN_LOCK_PROBE = "/edge-lock";

/**
 * The secret Cloudflare adds, whether a request without it is refused (false: only the probe says
 * so), and a mark for when the secret was read (config.ts `originLockRead`).
 */
export interface OriginLock {
  secret: string;
  enforce: boolean;
  read: string;
}

/** A CIDR's first 32 bits as a number (`head` reads them from the address), with its prefix length. */
function network(cidr: string, head: (address: string) => number): [number, number] {
  const [address, bits] = cidr.split("/");
  if (Number(bits) > 32) throw new Error(`${cidr}: the viewer function compares 32 bits at most`);
  return [head(address!), Number(bits)];
}
