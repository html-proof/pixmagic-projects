// Geist ships with the `geist` package (next/font/local), so the build never has to reach Google
// Fonts. Apply `${GeistSans.variable} ${GeistMono.variable}` on the landing root; the `lp-root`
// utility and the `font-lp` / `font-lp-mono` Tailwind families read these variables.
export { GeistSans } from "geist/font/sans";
export { GeistMono } from "geist/font/mono";
