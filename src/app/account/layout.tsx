// The browser tab names the page: this route's title, merged into the
// root layout's template. A server layout so the title is in the static
// HTML itself, which a client page cannot put there.

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Account", description: "Sign in for the hosted Whale Radar, see whether the radar recognises you, and manage your plan and API keys." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
