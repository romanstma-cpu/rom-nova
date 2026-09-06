import type { Metadata } from "next";
import { Space_Grotesk, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Shell } from "@/components/chrome/Shell";

const sans = Space_Grotesk({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const mono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://romapps.xyz/nova"),
  // Each route's layout.tsx supplies the %s; the root page keeps the default.
  title: { default: "ROM Nova — Solana On-Chain Intelligence", template: "%s · ROM Nova" },
  description:
    "A Solana intelligence terminal: a Whale Radar that finds and scores whale wallets by itself and grades its own signals, live tokens and launches, launch forensics, a wallet ledger with a measured reputation, and a copy desk that holds no key. What is simulated is labelled. Analytics and decision support, not investment advice.",
  openGraph: {
    title: "ROM Nova — Solana On-Chain Intelligence",
    description:
      "See the whales, trust the numbers: a radar that discovers and grades whale wallets on its own, live launches triaged in a second, and a copy desk that never holds a key. Part of ROM Apps.",
    type: "website",
    siteName: "ROM Nova",
    // The card a shared link unfurls into — Discord, X, iMessage, Slack —
    // rendered from the app's own palette and icon (public/og.png).
    images: [{ url: "/nova/og.png", width: 1200, height: 630, alt: "ROM Nova — Solana on-chain intelligence" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ROM Nova — Solana On-Chain Intelligence",
    description: "A whale radar that finds and grades wallets by itself, launches triaged in seconds, and a copy desk that never holds a key.",
    images: ["/nova/og.png"],
  },
  robots: { index: true, follow: true },
  // Installable from the browser: the manifest names the app, its icons and
  // its start URL, so Chrome and Edge offer "Install ROM Nova" and a phone
  // can pin it to the home screen with the app's own icon and colour.
  manifest: process.env.NEXT_PUBLIC_STATIC === "1" ? "/nova/manifest.webmanifest" : "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "ROM Nova", statusBarStyle: "black-translucent" },
};

export const viewport = {
  themeColor: "#04060a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${sans.variable} ${mono.variable} antialiased`} style={{ fontFamily: "var(--font-sans), system-ui, sans-serif" }}>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
