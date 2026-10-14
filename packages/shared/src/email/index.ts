// Email integrations and automation: the pure rules shared by the API and the UI (docs/email.md).
// `@app/shared/email` (not re-exported from the root barrel, whose names it would collide with).
export * from "./constants";
export * from "./address";
export * from "./events";
export * from "./conditions";
export * from "./template";
export * from "./sanitize";
export * from "./dns";
export * from "./network";
export * from "./schemas";
