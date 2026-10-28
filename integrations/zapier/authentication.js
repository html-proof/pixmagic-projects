// Connecting bizinsights in Zapier: OAuth 2.0 with bizinsights as the provider (docs/zapier.md).
// Zapier opens bizinsights' consent page, where the member chooses the store and allows it; bizinsights
// sends Zapier back with a code, which is exchanged here for an access token (an hour) and a refresh
// token (rotated on every refresh). CLIENT_ID and CLIENT_SECRET are the Zapier app's environment,
// the same values as bizinsights' ZAPIER_CLIENT_ID and ZAPIER_CLIENT_SECRET.
const { apiUrl, baseUrl } = require("./lib/api");

const tokenRequest = (z, body) =>
  z.request({
    url: apiUrl("/oauth/token"),
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: { ...body, client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET },
  });

/** The consent page, with Zapier's state and redirect URI passed through untouched. */
const authorizeUrl = (z, bundle) => {
  const q = new URLSearchParams({
    client_id: process.env.CLIENT_ID || "",
    state: bundle.inputData.state,
    redirect_uri: bundle.inputData.redirect_uri,
    response_type: "code",
  });
  return `${baseUrl()}/connect/zapier?${q.toString()}`;
};

const getAccessToken = async (z, bundle) => {
  const response = await tokenRequest(z, { grant_type: "authorization_code", code: bundle.inputData.code, redirect_uri: bundle.inputData.redirect_uri });
  return { access_token: response.data.access_token, refresh_token: response.data.refresh_token };
};

const refreshAccessToken = async (z, bundle) => {
  const response = await tokenRequest(z, { grant_type: "refresh_token", refresh_token: bundle.authData.refresh_token });
  return { access_token: response.data.access_token, refresh_token: response.data.refresh_token };
};

/** The connection test: which store this connection reaches. */
const test = async (z) => (await z.request({ url: apiUrl("/zapier/me") })).data;

module.exports = {
  type: "oauth2",
  oauth2Config: {
    authorizeUrl,
    getAccessToken,
    refreshAccessToken,
    autoRefresh: true,
  },
  test,
  // The test's answer: "Store name (Workspace)".
  connectionLabel: (z, bundle) => bundle.inputData.label || (bundle.inputData.store && bundle.inputData.store.name) || "bizinsights",
  fields: [],
};
