// Preloaded (node --import) for Playwright's browser download on the self-hosted runner (ci.yml).
// That PC's network hands out IPv6 addresses with no route behind them. Playwright's downloader
// always tries IPv6 first, and each attempt dies after 5 s with a misleading "timed out after
// 30000ms". With IPv6 lookups failing, it goes straight to IPv4.
import dns from "node:dns";

const lookup = dns.promises.lookup.bind(dns.promises);
dns.promises.lookup = (host, options) =>
  options && options.family === 6
    ? Promise.reject(
        Object.assign(new Error(`IPv6 lookups are off (${host})`), {
          code: "ENOTFOUND",
        }),
      )
    : lookup(host, options);
