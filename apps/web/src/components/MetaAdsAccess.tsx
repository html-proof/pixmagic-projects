import Link from "next/link";
import { CONTACT } from "@/lib/contact";

/**
 * Facebook's "Feature Unavailable" page, explained on bizinsights' side. Facebook shows it instead of
 * its login when it won't let that Facebook account use bizinsights' Meta app, and never sends the
 * person back. Two causes:
 * - Meta hasn't given the app Advanced Access to ads_read yet (App Review): only the people added to
 *   the app (testers) can connect. The API says so as `restricted.meta`.
 * - Meta has paused the app's login (e.g. its admin's developer account needs confirming): nobody can.
 * docs/ads-setup.md, "Facebook says Feature Unavailable", has the owner's side.
 */

const REQUESTS_URL = "https://developers.facebook.com/requests/";
const link = "text-accent underline-offset-2 hover:underline";

/** Where a merchant asks to be added as a tester, or reports the login being paused. */
function AskUs({ subject }: { subject: string }) {
  const mail = CONTACT.supportEmail;
  return mail ? (
    <a className={link} href={`mailto:${mail}?subject=${encodeURIComponent(subject)}`}>
      email us
    </a>
  ) : (
    <Link prefetch={false} className={link} href="/support">
      contact us
    </Link>
  );
}

function HowToBeAdded() {
  return (
    <>
      To be added, <AskUs subject="Add me as a Meta Ads tester" /> with a link to the Facebook profile you&apos;ll connect with. Facebook then sends you an invitation: accept it
      under{" "}
      <a className={link} href={REQUESTS_URL} target="_blank" rel="noopener noreferrer">
        developers.facebook.com → Requests
      </a>{" "}
      and press Continue with Meta Ads again.
    </>
  );
}

/** On the Meta Ads card, before anyone is sent to Facebook. */
export function MetaTestersOnly() {
  return (
    <p className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted" data-testid="meta-testers-only">
      <strong className="text-text">Meta hasn&apos;t approved bizinsights for every Facebook account yet.</strong> Until it does, only accounts we&apos;ve added as testers can connect;
      any other Facebook account gets Facebook&apos;s &ldquo;Feature Unavailable&rdquo; page. <HowToBeAdded />
    </p>
  );
}

/** Back from Facebook without connecting: what its error page meant. */
export function BackFromFacebook({ restricted }: { restricted: boolean }) {
  return (
    <span data-testid="meta-back">
      Back from Facebook without connecting? Nothing was connected.{" "}
      {restricted ? (
        <>
          If Facebook said &ldquo;Feature Unavailable&rdquo;, it turned that Facebook account away: Meta hasn&apos;t approved bizinsights for every account yet, only for the testers
          we&apos;ve added. <HowToBeAdded /> Already a tester and still seeing it? Then Meta has paused bizinsights&apos; Facebook login, which is on our side: please try again later.
        </>
      ) : (
        <>
          If Facebook said &ldquo;Feature Unavailable&rdquo;, Meta has paused bizinsights&apos; Facebook login. That&apos;s on our side, not your account&apos;s: please try again later,
          or <AskUs subject="Meta Ads: Feature Unavailable" />.
        </>
      )}
    </span>
  );
}
