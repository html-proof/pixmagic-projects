/** Keep distinct HTTP failures distinct in recovery UI. */
export function errorKind(status: number) {
  switch (status) {
    case 0: return "network";
    case 400: return "request";
    case 401: return "session";
    case 402: return "payment";
    case 403: return "forbidden";
    case 404: return "missing";
    case 408: return "timeout";
    case 409: return "conflict";
    case 410: return "gone";
    case 413: return "tooLarge";
    case 422: return "validation";
    case 429: return "rateLimit";
    case 502: return "gateway";
    case 503: return "unavailable";
    case 504: return "gatewayTimeout";
    default: return status >= 500 ? "server" : "request";
  }
}
export const canRetryLoad = (status: number) => status === 0 || status === 408 || status === 409 || status === 429 || status >= 500;
