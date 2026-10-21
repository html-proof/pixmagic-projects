"use client";

/** Last-resort recovery when even the root layout fails. Styles may be unavailable here. */

export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {

  return <html lang="en"><body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "clamp(24px, 8vw, 96px)", color: "#1b1b18", background: "#f7f7f5" }}>

    <main style={{ maxWidth: 560, margin: "0 auto" }}>

      <p>BizInsights · 500</p><h1>Something went wrong</h1>

      <p>We couldn't open this page. Try again or contact support if the problem continues.</p>

      <button type="button" onClick={retry} style={{ padding: "12px 20px", cursor: "pointer" }}>Try again</button>{" "}

      <a href="/support">Contact support</a>

    </main>

  </body></html>;

}
