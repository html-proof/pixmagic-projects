/**
 * What sending the app's email needs, without the rest of core (no database, no Prisma): the entry
 * for code that only sends mail, such as Cognito's email trigger (apps/aws/src/cognitoEmail.ts),
 * whose bundle then stays small. The same modules as the main entry's, so classes like MailError
 * are the same either way.
 */
export { env } from "./env.js";
export { logger, withLogContext } from "./logger.js";
export { withTimeout } from "./http.js";
export * from "./mail/types.js";
export * from "./mail/resend.js";
export * from "./mail/authEmails.js";
export type { Mailer, MailOptions } from "./notify.js";
export type { FetchLike } from "./shopify.js";
