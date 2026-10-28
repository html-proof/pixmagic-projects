// What every part of the app shares: bizinsights' address, the bearer token on each request, and
// bizinsights' errors read into Zapier's.

/** bizinsights' site (BASE_URL in the Zapier app's environment; https://bizinsights.io by default). */
const baseUrl = () => (process.env.BASE_URL || "https://bizinsights.io").replace(/\/+$/, "");

/** bizinsights' API: everything Zapier calls is under /api. */
const apiUrl = (path) => `${baseUrl()}/api${path}`;

const isTokenEndpoint = (url) => String(url || "").includes("/api/oauth/token");

/** Every request but the token endpoint's carries the connection's access token. */
const includeBearerToken = (request, z, bundle) => {
  if (bundle.authData && bundle.authData.access_token && !isTokenEndpoint(request.url)) {
    request.headers = request.headers || {};
    request.headers.Authorization = `Bearer ${bundle.authData.access_token}`;
  }
  return request;
};

/**
 * bizinsights' answers: 401 means the access token ran out or no longer stands (Zapier refreshes it,
 * and asks to reconnect if that fails too); any other refusal is shown with bizinsights' own message
 * ({ "error": code, "message": text }), which is written for the person setting up the Zap.
 */
const handleErrors = (response, z) => {
  if (isTokenEndpoint(response.request && response.request.url)) return response;
  if (response.status === 401) throw new z.errors.RefreshAuthError("bizinsights asked for the connection again.");
  if (response.status >= 400) {
    const data = response.data || {};
    const message = (data && data.message) || `bizinsights answered ${response.status}.`;
    throw new z.errors.Error(message, (data && data.error) || "bizinsights_error", response.status);
  }
  return response;
};

module.exports = { apiUrl, baseUrl, handleErrors, includeBearerToken };
