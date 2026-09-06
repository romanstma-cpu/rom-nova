// The browser tab names the page: this route's title, merged into the
// root layout's template. A server layout so the title is in the static
// HTML itself, which a client page cannot put there.

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Backtest Lab", description: "Replay the scoring engine over the simulated universe's history and read what it would have called. Simulated, and labelled so." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
