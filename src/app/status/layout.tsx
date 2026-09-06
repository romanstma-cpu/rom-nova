// The browser tab names the page: this route's title, merged into the
// root layout's template. A server layout so the title is in the static
// HTML itself, which a client page cannot put there.

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Status", description: "Every source, socket and store this tab uses, and how live each one is right now." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
