// When each alert source was last asked, and the one way to ask sooner.
//
// The monitor used to hold this in a `useRef` inside the component, which was
// fine until a socket wanted a say. A `logsSubscribe` on a watched wallet
// tells this tab "something just happened to that address" a few hundred
// milliseconds after the block — and the honest thing to do with that is not
// to assert a fill (the notification carries no balance change) but to READ
// THE WALLET NOW instead of at the four-minute cadence. That needs the
// attempt clock to live somewhere a socket handler can reach, and the socket
// handler is not a React component.
//
// A nudge clears one key's last attempt, so the next tick sees it as due, and
// wakes the monitor so "next tick" is now rather than up to ten seconds away.
// It never evaluates anything itself: the evaluation still goes through the
// same rate-gated seams and the same evaluators, with the same records. The
// socket only decides WHEN, never WHAT.

const attempts = new Map<string, number>();
const nudgeListeners = new Set<(key: string) => void>();
let nudges = 0;
let lastNudge: { key: string; at: number } | undefined;

export function lastAttemptAt(key: string): number {
  return attempts.get(key) ?? 0;
}

export function noteAttempt(key: string, now: number): void {
  attempts.set(key, now);
}

/** Whether a source is due, by its cadence, at `now`. */
export function due(key: string, everyMs: number, now: number): boolean {
  return now - lastAttemptAt(key) >= everyMs;
}

/**
 * Make `key` due immediately and wake whoever is listening.
 *
 * Idempotent and cheap: clearing an attempt that is already clear changes
 * nothing, and the monitor coalesces wakes, so a busy wallet notifying ten
 * times in a second costs one read, not ten.
 */
export function nudge(key: string, now = Date.now()): void {
  attempts.delete(key);
  nudges++;
  lastNudge = { key, at: now };
  for (const l of nudgeListeners) {
    try {
      l(key);
    } catch {
      /* one listener's failure must not swallow the others' wake */
    }
  }
}

export function subscribeNudges(l: (key: string) => void): () => void {
  nudgeListeners.add(l);
  return () => {
    nudgeListeners.delete(l);
  };
}

/** For the alerts page and /status: how often the sockets have pulled the clock forward. */
export function nudgeStats(): { nudges: number; last?: { key: string; at: number } } {
  return { nudges, last: lastNudge };
}

/** Test seam. */
export function resetCadence(): void {
  attempts.clear();
  nudges = 0;
  lastNudge = undefined;
}
