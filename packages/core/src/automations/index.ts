// The Automations hub (docs/automations.md): one four-step setup and one history over the
// channels' own engines. `@app/core/automations`, not in the core barrel (its names would clash
// with the channels').
export * from "./common.js";
export * from "./hub.js";
export { smsConnect, smsDisconnect } from "./sms.js";
export { emailDisconnect, emailTestConnection } from "./email.js";
