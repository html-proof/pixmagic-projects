/**
 * The facts about the business behind Insights that the code cannot know: who the data controller
 * is, how a merchant reaches support, and which law governs the policy.
 *
 * Shopify app store requirement 4.1 requires a reachable support contact, and the listing requires a
 * privacy policy URL. `/privacy`, `/data-deletion` and `/support` render straight from this file, and
 * so does the Meta Ads "email us" link. `postalAddress` is optional: the policy leaves the address out
 * while it is blank. The other three must stay filled in; Google and Meta reject a policy without them.
 */
export const CONTACT: Readonly<{
  /** Entity that controls merchant data, as registered. Appears as the controller and in the copyright. */
  legalName: string;
  /** Support address merchants write to. Must be monitored - review tests it. */
  supportEmail: string;
  /** State or country whose law governs the policy. */
  jurisdiction: string;
  /** Postal address of the controller. Required by GDPR art. 13 where it applies. */
  postalAddress: string;
}> = {
  legalName: "Insight",
  supportEmail: "sales@ikorex.com.au",
  jurisdiction: "Victoria, Australia",
  postalAddress: "",
};
