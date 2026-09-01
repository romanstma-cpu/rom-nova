"use client";

// Unread live-alert count in the chrome, so a fired alert is visible from
// every page and not only when the inbox happens to be open.
//
// Reads the alerts blob through useSyncExternalStore for the same reason the
// track-record page does: the monitor writes it from outside React, another
// tab can write it through the storage event, and reading localStorage during
// render is a hydration mismatch. The server snapshot is empty, so the badge
// appears on the first client render after mount.

import { useMemo, useSyncExternalStore } from "react";
import Link from "next/link";
import { alertsRaw, alertsRawServer, parseAlerts, subscribeAlerts } from "@/lib/alerts/store";

export function AlertBadge() {
  const raw = useSyncExternalStore(subscribeAlerts, alertsRaw, alertsRawServer);
  const { unread, truncated } = useMemo(() => {
    const blob = parseAlerts(raw);
    return {
      unread: blob.events.filter((e) => !e.read).length,
      // The count can only ever describe the alerts still HELD. Once the inbox
      // has evicted anything, it is a floor rather than a total, and a bare
      // number would quietly saturate at the cap while claiming precision.
      truncated: Object.values(blob.dropped ?? {}).reduce((a, b) => a + b, 0) > 0,
    };
  }, [raw]);

  const count = `${unread}${truncated ? "+" : ""}`;
  return (
    <Link
      href="/alerts"
      className="btn text-[11px] flex items-center gap-1.5"
      title={
        unread > 0
          ? `${count} unread live alert${unread === 1 ? "" : "s"} — fired by this browser's client-side monitor.` +
            (truncated ? " The inbox has evicted older alerts, so this is a floor, not a total." : "")
          : "Live alerts — client-side monitoring, evaluated in this tab"
      }
      aria-label={`Alerts${unread > 0 ? `, ${count} unread` : ""}`}
    >
      <span aria-hidden="true">◬</span>
      {unread > 0 && <span className="chip chip-accent text-[10px] num px-1.5">{count}</span>}
    </Link>
  );
}
