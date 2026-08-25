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
  title: "ROM Nova — Solana On-Chain Intelligence",
  description:
    "An explainable Solana intelligence terminal: whale tracking, signal scoring, backtesting and a live 3D network — running on clearly-labeled simulated data. Analytics and decision support, not investment advice.",
  openGraph: {
    title: "ROM Nova — Solana On-Chain Intelligence",
    description:
      "Follow simulated smart money, rank setups by evidence, and explore the market as a living 3D network. Part of ROM Apps.",
    type: "website",
    siteName: "ROM Nova",
  },
  robots: { index: true, follow: true },
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
