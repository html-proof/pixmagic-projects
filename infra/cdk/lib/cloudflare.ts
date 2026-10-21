/**
 * The addresses Cloudflare's proxy connects to origins from, as published at
 * https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6 (checked 2026-10-16).
 *
 * bizinsights.io's DNS is at Cloudflare, proxied, so CloudFront sees one of these as the viewer and
 * the real client in `CF-Connecting-IP`. Cloudflare sets that header itself on every proxied request,
 * so it is believed only on requests that come from these ranges: the viewer-request function and the
 * WAF's per-client rate limit both key on it then. If Cloudflare adds a range, add it here: until then
 * clients behind it share their edge address for rate limits, nothing breaks.
 */
export const CLOUDFLARE_IPV4 = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

export const CLOUDFLARE_IPV6 = ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"];

/** The header Cloudflare's proxy puts the client's address in. */
export const CLOUDFLARE_CLIENT_IP_HEADER = "cf-connecting-ip";
