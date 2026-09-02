// How to SAY the window a flow figure was measured over.
//
// A leaf on purpose — no imports — because two sides of the app need the same
// sentence: the engine writes it into a signal's invalidation copy, and the
// signal page prints it as the caption on the feature snapshot. When those two
// were written separately, one said "a ten-minute chain scan, not a 6h window"
// and the other said "whale net 6h" about the same number on the same screen.

const HOUR = 3_600_000;

/**
 * "6h", "10 min", "4.2 min" — or "no window" when nothing read any flow.
 *
 * Minutes keep a decimal below ten because a byte-budgeted read that stopped
 * at 4.2 minutes covered 4.2, and rounding it to "4 min" is a small lie in
 * the direction this app is least allowed to lie in.
 */
export function flowWindowLabel(ms: number | undefined): string {
  if (ms === undefined || !(ms > 0)) return "no window";
  if (ms >= HOUR) {
    const h = ms / HOUR;
    return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
  }
  const min = ms / 60_000;
  return `${min < 10 && !Number.isInteger(min) ? min.toFixed(1) : Math.round(min)} min`;
}

/** Whether the window is a short chain scan rather than a trailing-hours read. */
export function isChainScanWindow(ms: number | undefined): boolean {
  return ms !== undefined && ms > 0 && ms < HOUR;
}
