// The browser tab names the page: this route's title, merged into the
// root layout's template. A server layout so the title is in the static
// HTML itself, which a client page cannot put there.

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Whale Radar", description: "The Whale Radar finds and scores whale wallets on its own from two public streams, and says when a proven one buys again." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
