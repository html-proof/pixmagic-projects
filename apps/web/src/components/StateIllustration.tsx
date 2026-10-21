/** Lightweight, theme-aware illustrations; the surrounding text carries their meaning. */
export function StateIllustration({ kind, compact = false }: { kind: "forbidden" | "session" | "empty" | "integration" | "server" | "unavailable" | "network" | "sync" | "invite" | "payment" | "validation"; compact?: boolean }) {
  return <svg viewBox="0 0 320 180" aria-hidden="true" focusable="false" className={compact ? "h-24 w-40 max-w-full shrink-0 text-accent" : "h-auto w-72 max-w-full text-accent"}>
    <ellipse cx="160" cy="163" rx="129" ry="9" fill="currentColor" opacity=".07" />
    <circle cx="160" cy="88" r="72" fill="currentColor" opacity=".05" />
    <g fill="none" stroke="currentColor" strokeWidth="2" opacity=".25"><path d="M38 64h12m-6-6v12m226 44h12m-6-6v12M70 126h9m164-87h10"/><circle cx="261" cy="67" r="4"/><circle cx="62" cy="39" r="3"/></g>
    {kind === "forbidden" ? <>
      <text x="160" y="131" textAnchor="middle" fontSize="108" fontWeight="800" fontFamily="system-ui, sans-serif" fill="currentColor" opacity=".12">403</text>
      <path d="M135 80V61a25 25 0 0 1 50 0v19" fill="none" stroke="currentColor" strokeWidth="8" />
      <rect x="122" y="77" width="76" height="66" rx="15" fill="var(--surface)" stroke="currentColor" strokeWidth="2"/>
      <circle cx="160" cy="104" r="7" fill="currentColor"/><path d="M160 109v12" stroke="currentColor" strokeWidth="5" strokeLinecap="round"/>
      <path d="m218 133 10-30 10 30m-10-3v29M92 144l-8-24-8 24m8-2v17" fill="none" stroke="currentColor" strokeWidth="2" opacity=".35"/>
    </> : kind === "session" ? <>
      <rect x="69" y="31" width="182" height="120" rx="12" fill="var(--surface)" stroke="currentColor" strokeWidth="2"/>
      <path d="M69 55h182" stroke="currentColor" opacity=".2"/><g fill="currentColor" opacity=".4"><circle cx="83" cy="43" r="2.5"/><circle cx="93" cy="43" r="2.5"/><circle cx="103" cy="43" r="2.5"/></g>
      <rect x="126" y="80" width="48" height="39" rx="8" fill="currentColor" opacity=".12"/><path d="M137 81v-9a13 13 0 0 1 26 0v9" fill="none" stroke="currentColor" strokeWidth="3"/>
      <circle cx="183" cy="115" r="21" fill="var(--surface)" stroke="currentColor" strokeWidth="2"/><path d="M183 102v13l8 5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
    </> : kind === "empty" ? <>
      <rect x="64" y="28" width="192" height="123" rx="12" fill="var(--surface)" stroke="currentColor" strokeWidth="2" opacity=".65"/>
      <path d="M64 51h192M82 68h46m-46 12h30m81-12h43" stroke="currentColor" strokeWidth="3" opacity=".2"/>
      <path d="m123 97 15-17h44l15 17v37h-74Z" fill="var(--surface)" stroke="currentColor" strokeWidth="2"/>
      <path d="M123 98h23l5 9h18l5-9h23" fill="none" stroke="currentColor" strokeWidth="2"/>
      <path d="M151 65v-8m-17 14-6-6m40 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".5"/>
    </> : kind === "server" || kind === "unavailable" ? <>
      <text x="160" y="122" textAnchor="middle" fontSize="100" fontWeight="800" fontFamily="system-ui, sans-serif" fill="currentColor" opacity=".1">{kind === "server" ? "500" : "503"}</text>
      <rect x="121" y="40" width="78" height="102" rx="12" fill="var(--surface)" stroke="currentColor" strokeWidth="2" />
      <path d="M135 63h35m-35 22h35m-35 22h20" stroke="currentColor" strokeWidth="3" opacity=".4" strokeLinecap="round" />
      <circle cx="184" cy="63" r="3" fill="currentColor" /><circle cx="184" cy="85" r="3" fill="currentColor" />
      {kind === "server" ? <><circle cx="192" cy="129" r="21" fill="var(--surface)" stroke="var(--danger)" strokeWidth="2"/><path d="M192 117v14m0 7v1" stroke="var(--danger)" strokeWidth="3" strokeLinecap="round"/></> : <path d="m176 137 31-31a14 14 0 0 0 16-19l-11 11-9-9 11-11a14 14 0 0 0-19 16l-31 31Z" fill="var(--surface)" stroke="currentColor" strokeWidth="2"/>}
    </> : kind === "network" || kind === "sync" ? <>
      <rect x="85" y="39" width="150" height="101" rx="12" fill="var(--surface)" stroke="currentColor" strokeWidth="2" />
      <path d="M69 147h182m-91-7v7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity=".5" />
      {kind === "network" ? <><path d="M124 80q36-32 72 0m-58 16q22-20 44 0m-31 15q9-7 18 0" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round"/><path d="m130 62 61 62" stroke="var(--surface)" strokeWidth="9"/><path d="m130 62 61 62" stroke="currentColor" strokeWidth="3"/></> : <><path d="M135 81a30 30 0 0 1 50-10l8 8m-14 0h14V65m-8 36a30 30 0 0 1-50 10l-8-8m14 0h-14v14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/><path d="M160 81v13m0 6v1" stroke="var(--danger)" strokeWidth="3" strokeLinecap="round"/></>}
    </> : kind === "invite" ? <>
      <path d="m93 75 67-37 67 37v67H93Z" fill="var(--surface)" stroke="currentColor" strokeWidth="2" />
      <rect x="117" y="40" width="86" height="88" rx="7" fill="var(--surface)" stroke="currentColor" strokeWidth="2"/>
      <path d="m93 76 67 42 67-42m-134 66 44-39m90 39-44-39m-47-43h47m-47 13h30" fill="none" stroke="currentColor" strokeWidth="2" opacity=".5"/>
      <circle cx="222" cy="129" r="22" fill="var(--surface)" stroke="currentColor" strokeWidth="2"/><path d="M222 116v13l8 5" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round"/>
    </> : kind === "payment" ? <>
      <rect x="81" y="47" width="157" height="98" rx="13" fill="var(--surface)" stroke="currentColor" strokeWidth="2" />
      <path d="M82 76h155" stroke="currentColor" strokeWidth="15" opacity=".13"/>
      <path d="M101 119h28m9 0h18" stroke="currentColor" strokeWidth="4" opacity=".4" strokeLinecap="round"/>
      <circle cx="224" cy="129" r="24" fill="var(--surface)" stroke="var(--danger)" strokeWidth="2"/><path d="m217 122 14 14m0-14-14 14" stroke="var(--danger)" strokeWidth="3" strokeLinecap="round"/>
    </> : kind === "validation" ? <>
      <rect x="104" y="28" width="112" height="125" rx="12" fill="var(--surface)" stroke="currentColor" strokeWidth="2" />
      <path d="M124 53h50m-50 19h72m-72 30h72m-72 30h40" stroke="currentColor" strokeWidth="4" opacity=".3" strokeLinecap="round"/>
      <rect x="120" y="87" width="80" height="30" rx="5" fill="none" stroke="var(--danger)" strokeWidth="2"/>
      <path d="m181 96 10 10m0-10-10 10" stroke="var(--danger)" strokeWidth="2"/>
    </> : <>
      <rect x="51" y="48" width="88" height="83" rx="13" fill="var(--surface)" stroke="currentColor" strokeWidth="2" opacity=".65"/>
      <rect x="181" y="48" width="88" height="83" rx="13" fill="var(--surface)" stroke="currentColor" strokeWidth="2" opacity=".65"/>
      <path d="M72 105V88m14 17V76m14 29V83m14 22V68" stroke="currentColor" strokeWidth="6" strokeLinecap="round" opacity=".4"/>
      <path d="m213 74-9 17h28l-9 17" stroke="currentColor" strokeWidth="3" fill="none" strokeLinejoin="round"/>
      <path d="M139 90h14m15 0h13m-29-13-6-8m22 38 6 8" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
      <circle cx="160" cy="90" r="3" fill="var(--danger)"/>
    </>}
  </svg>;
}
