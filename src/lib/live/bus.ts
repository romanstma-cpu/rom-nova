// The one place live events enter the UI.
//
// The static export has no server, so there is no SSE stream; `useEventStream`
// falls through to `localSubscribe`, which forwarded the DEMO store's events
// and nothing else. Every toast and every activity-feed row in the shipped app
// was therefore synthetic — labelled SIMULATED on one surface and unlabelled on
// another, which the whole-build review caught as one stream wearing two
// labels. This module is where REAL events (a signal a live token just
// reached, a launch pushed by a socket, a watched wallet that just transacted)
// join that subscription, carrying a `real` flag so no surface has to guess.
//
// Deliberately tiny and framework-free: publishers live in `src/lib/live/*`
// and in the signal engine's live path, and the only consumer is the same
// subscription the demo store already feeds. Nothing here touches storage.

export interface LiveEvent {
  id: string;
  kind: string;
  /** ms epoch on THIS machine's clock — receipt time, uncorrected. */
  ts: number;
  mint?: string;
  wallet?: string;
  amountUsd?: number;
  headline: string;
  detail: string;
  confidence?: number;
  symbol?: string;
  /**
   * True only when a real source produced this. Demo events omit it (or set
   * false), so a renderer that reads `real !== true` as "SIMULATED" labels the
   * old stream correctly without knowing anything else.
   */
  real: boolean;
  /** The adapter or socket that produced it — "pumpportal-ws", "signals-live"… */
  source: string;
}

type Listener = (e: LiveEvent) => void;

const listeners = new Set<Listener>();
let seq = 0;

/** Publish one live event to every subscriber. Never throws into the caller. */
export function emitLiveEvent(e: Omit<LiveEvent, "id"> & { id?: string }): LiveEvent {
  const full: LiveEvent = { ...e, id: e.id ?? `live-${Date.now().toString(36)}-${(seq++).toString(36)}` };
  for (const l of listeners) {
    try {
      l(full);
    } catch {
      // A broken subscriber must not stop the others hearing the event.
    }
  }
  return full;
}

/** Subscribe; returns the unsubscribe. */
export function subscribeLiveEvents(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** For tests and for /status: how many surfaces are listening. */
export function liveListenerCount(): number {
  return listeners.size;
}
