// The browser tab names the page: this route's title, merged into the
// root layout's template. A server layout so the title is in the static
// HTML itself, which a client page cannot put there.

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Alerts", description: "Rules this browser evaluates while it is open: whale moves, watched wallets and radar signals, with system notifications when you allow them." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
