import type { MetadataRoute } from "next";

/** The web app manifest: the name and icons a phone uses when the dashboard is added to its home screen. */
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "bizinsights",
    short_name: "bizinsights",
    description: "Your Shopify store's numbers in plain language.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#1b1c19",
    theme_color: "#1b1c19",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
