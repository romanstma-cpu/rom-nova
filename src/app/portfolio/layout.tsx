// The browser tab names the page: this route's title, merged into the
// root layout's template. A server layout so the title is in the static
// HTML itself, which a client page cannot put there.

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Paper Desk", description: "A paper desk: practice trades on simulated fills with no real funds, no wallet and no key." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
