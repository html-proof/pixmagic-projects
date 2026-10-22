/**
 * Nango's Connect UI (docs/nango.md): opened over the page with a session token from bizinsights' API,
 * it shows the platform's own consent screen (in a popup) for bizinsights' Meta app or Google client and
 * says when a connection was made. The SDK is loaded only when someone presses the button, so it costs
 * nothing on the pages' first load.
 */

/** What the Connect UI said, as the card acts on it. */
export type NangoConnectOutcome =
  | { kind: "connected"; connectionId: string; providerConfigKey: string }
  | { kind: "closed" }
  | { kind: "error"; type: string; message: string };

/** How long the Connect UI's frame has to say it's ready before the page gives up on it (blocked, offline). */
const LOAD_TIMEOUT_MS = 20_000;

/**
 * Open the Connect UI with `token` and settle once with what happened: a connection was made (the UI is
 * closed for the page to take over), the person closed it first, or Nango reported an error. A frame
 * that never loads (an extension or network blocking connect.nango.dev) is closed after LOAD_TIMEOUT_MS
 * as an error of type "load_timeout", never left over the page.
 */
export async function openNangoConnect(token: string): Promise<NangoConnectOutcome> {
  const { default: Nango } = await import("@nangohq/frontend");
  return new Promise<NangoConnectOutcome>((resolve) => {
    let settled = false;
    const settle = (o: NangoConnectOutcome) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(watchdog);
      ui.close();
      resolve(o);
    };
    const watchdog = window.setTimeout(() => settle({ kind: "error", type: "load_timeout", message: "The Connect UI didn't load" }), LOAD_TIMEOUT_MS);
    const ui = new Nango().openConnectUI({
      onEvent: (event) => {
        window.clearTimeout(watchdog);
        if (event.type === "connect") settle({ kind: "connected", connectionId: event.payload.connectionId, providerConfigKey: event.payload.providerConfigKey });
        else if (event.type === "close") settle({ kind: "closed" });
        else if (event.type === "error") settle({ kind: "error", type: event.payload.errorType, message: event.payload.errorMessage });
      },
    });
    ui.setSessionToken(token);
  });
}
