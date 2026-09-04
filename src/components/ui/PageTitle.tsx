"use client";

// The first line of every page, in one shape.
//
// Before this, the rail said "Wallets" and the page said WHALE INTELLIGENCE;
// "Scanner" opened LIVE DISCOVERY SCANNER; "Signals" opened SIGNAL TERMINAL.
// Each title was defensible on its own and together they taught a reader
// that the rail could not be trusted to say where a click lands. The title
// here is the rail label, and the one-line lede says what the page is for,
// so nobody has to open the explainer to find out.
//
// Inline, not stacked: every page keeps its filter chips and controls on the
// title row, and a lede on its own line would push them all down.

export function PageTitle({ title, lede, className = "" }: { title: string; lede?: string; className?: string }) {
  return (
    <span className={`flex items-baseline gap-2.5 min-w-0 mr-1 ${className}`}>
      <h1 className="text-[15px] font-semibold tracking-wide shrink-0" title={lede}>
        {title}
      </h1>
      {lede && <span className="page-lede hidden lg:inline truncate">{lede}</span>}
    </span>
  );
}
