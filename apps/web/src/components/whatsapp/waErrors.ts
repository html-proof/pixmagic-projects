/**
 * The WhatsApp API's refusals that come with a 5xx status (WhatsappError in @app/core: the service
 * is switched off, didn't answer, or refused), in the page's own words. api() never shows a 5xx
 * body's text (it may hold a provider's diagnostics) and words every 5xx as an outage, so without
 * these a service that is switched off on purpose (docs/whatsapp.md, "Cost") read "We can't reach
 * bizinsights right now. We'll keep trying." under every WhatsApp button.
 */
export const WA_OFF = "WhatsApp is switched off on bizinsights at the moment.";

const SERVICE_ERRORS: Readonly<Record<string, string>> = {
  provider_not_configured: `${WA_OFF} Nothing was changed.`,
  cloud_api_off: "Connecting through Meta's Cloud API isn't available on bizinsights at the moment. Nothing was changed.",
  provider_unavailable: "bizinsights' WhatsApp service didn't answer. Nothing was changed; try again in a minute.",
  provider_refused: "The WhatsApp service refused that. Nothing was changed.",
  provider_error: "Something went wrong talking to bizinsights' WhatsApp service. Nothing was changed.",
};

/** The sentence for a 5xx refusal the WhatsApp API named by its code, or null for anything else (a real outage included). */
export function waServiceError(status: number, code: string): string | null {
  return status >= 500 && Object.hasOwn(SERVICE_ERRORS, code) ? SERVICE_ERRORS[code]! : null;
}
