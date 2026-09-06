// The browser tab names the page: this route's title, merged into the
// root layout's template. A server layout so the title is in the static
// HTML itself, which a client page cannot put there.

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Launch Feed", description: "Every new Solana mint and pool as it lands, triaged in seconds: which checks ran, what they found, and what nobody could know yet." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
