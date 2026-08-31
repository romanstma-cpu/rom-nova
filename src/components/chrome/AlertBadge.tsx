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
  const unread = useMemo(() => parseAlerts(raw).events.filter((e) => !e.read).length, [raw]);

  return (
    <Link
      href="/alerts"
      className="btn text-[11px] flex items-center gap-1.5"
      title={
        unread > 0
          ? `${unread} unread live alert${unread === 1 ? "" : "s"} — fired by this browser's client-side monitor`
          : "Live alerts — client-side monitoring, evaluated in this tab"
      }
      aria-label={`Alerts${unread > 0 ? `, ${unread} unread` : ""}`}
    >
      <span aria-hidden="true">◬</span>
      {unread > 0 && <span className="chip chip-accent text-[10px] num px-1.5">{unread}</span>}
    </Link>
  );
}
