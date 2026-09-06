// The browser tab names the page: this route's title, merged into the
// root layout's template. A server layout so the title is in the static
// HTML itself, which a client page cannot put there.

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Token", description: "One token audited: score, security panel, holders, launch forensics and the chart, with every measurement named to its source." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
