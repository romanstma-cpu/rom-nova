/** A single stroke system for the workspace navigation. */
export function NavIcon({ href }: { href: string }) {
  const paths: Record<string, string> = {
    "/": "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    "/launches": "M4 16l4-4 4 3 8-11 M14 4h6v6 M4 21h16",
    "/scanner": "M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5 M3 12h18",
    "/signals": "M2 12h4l3-8 6 16 3-8h4",
    "/whales": "M3 6h15v4 M3 6v13h18V9H7a4 4 0 010-8h10 M16 13h5v3h-5z",
    "/radar": "M12 12l7-7 M12 3a9 9 0 109 9 M12 7a5 5 0 105 5 M12 11v2",
    "/alerts": "M5 17h14l-2-3V9a5 5 0 00-10 0v5z M10 21h4",
    "/tokens": "M12 3a9 9 0 100 18 9 9 0 000-18 M12 7v10 M8 9h8 M8 15h8",
    "/screener": "M3 5h18 M6 12h12 M9 19h6",
    "/watchlists": "M12 3l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z",
    "/track": "M4 3v18h17 M8 16l4-5 4 2 5-7",
    "/network": "M12 3l9 5v9l-9 5-9-5V8z M3 8l9 5 9-5 M12 13v9 M12 3v10",
    "/flow": "M3 7h18l-4-4 M21 17H3l4 4",
    "/portfolio": "M3 7h18v14H3z M8 7V3h8v4 M3 12h18 M10 12v3h4v-3",
    "/backtest": "M8 3h8 M10 3v7L4 21h16l-6-11V3 M7 16h10",
    "/research": "M4 3h12v5 M4 3v18h16V11 M9 15l2-5 7-7 3 3-7 7z",
    "/status": "M3 17h3v4H3z M10 10h3v11h-3z M17 3h3v18h-3z",
    "/account": "M12 3a4 4 0 100 8 4 4 0 000-8 M4 21v-2a8 5 0 0116 0v2",
    "/settings": "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
  };
  return <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[href] ?? paths["/"]} /></svg>;
}
