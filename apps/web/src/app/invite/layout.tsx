import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Shared dashboard · bizinsights",
  // An invitation page is never something to index, and nothing on it should be sent anywhere as a referrer.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * Before anything else on the page runs (the page's own scripts, and analytics a proxy may add at
 * the end of the body), the invitation token moves out of the address bar into this tab's
 * sessionStorage, so the link never shows up in an analytics hit, a screenshot of the address
 * bar, or the browser's history. The page reads it from there (invite/page.tsx readToken).
 */
const STASH_TOKEN = `(function(){try{var h=location.hash;if(h&&h.indexOf("token=")>-1){var t=new URLSearchParams(h.slice(1)).get("token");if(t){sessionStorage.setItem("bi:invite-token",t);history.replaceState(null,"",location.pathname+location.search);}}}catch(e){}})();`;

export default function InviteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: STASH_TOKEN }} />
      {children}
    </>
  );
}
