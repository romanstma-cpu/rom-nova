// The browser tab names the page: this route's title, merged into the
// root layout's template. A server layout so the title is in the static
// HTML itself, which a client page cannot put there.

import type { Metadata } from "next";

export const metadata: Metadata = { title: "3D Network", description: "The simulated universe as a galaxy: tokens, wallets and the money between them, in 3D. Simulated, and labelled so." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
