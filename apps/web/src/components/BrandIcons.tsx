/** Platform marks for the "Continue with …" buttons, drawn in each platform's own colours. */

export function MetaIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 36 24" width={size * 1.5} height={size} aria-hidden="true" className={className}>
      {/* The Meta loop, simplified. */}
      <path
        d="M4 13.5C4 8.8 6.6 5 10 5c3.1 0 5.1 2.8 8 7.6 2.9 4.8 4.9 7.4 8 7.4 3.2 0 6-3.2 6-7.5S29.4 5 26 5c-3.1 0-5.1 2.8-8 7.6C15.1 17.4 13.1 20 10 20c-3.3 0-6-2.6-6-6.5z"
        fill="none"
        stroke="#0866FF"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function GoogleIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" className={className}>
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
    </svg>
  );
}

/** The Google Ads mark, simplified: a yellow and a blue stroke meeting at the top, a green dot at the foot of the yellow one. */
export function GoogleAdsIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" className={className}>
      <path d="M24 10 11.5 33" stroke="#FBBC04" strokeWidth="10.5" strokeLinecap="round" />
      <circle cx="11.5" cy="35.5" r="6.3" fill="#34A853" />
      <path d="M24 10 36.5 33" stroke="#4285F4" strokeWidth="10.5" strokeLinecap="round" />
    </svg>
  );
}

/** The Google AdSense mark, simplified: a green dot, then a yellow and a blue stroke leaning the same way. */
export function AdsenseIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" className={className}>
      <circle cx="10" cy="40" r="5.6" fill="#34A853" />
      <path d="M16 30 25.5 11" stroke="#FBBC04" strokeWidth="9.5" strokeLinecap="round" />
      <path d="M27 36.5 36.5 17.5" stroke="#4285F4" strokeWidth="9.5" strokeLinecap="round" />
    </svg>
  );
}
