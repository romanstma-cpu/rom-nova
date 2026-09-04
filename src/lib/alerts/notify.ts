"use client";

// The system-notification boundary.
//
// Permission is requested ONLY from an explicit user action on the alerts
// page — never on load. A permission prompt the user did not ask for is how
// an app teaches its users to click "block", and once blocked, only the
// browser's own site settings can undo it.
//
// In the desktop shell the same web Notification API rides Chromium into the
// Windows notification center, and Electron grants permission without a
// prompt — so `state()` reports "granted" there from the start and the enable
// button simply confirms it. No shell-specific code path exists or is needed.

import type { LiveAlertEvent } from "./rules";

export type NotifyState = "unsupported" | "default" | "granted" | "denied";

export function notifyState(): NotifyState {
  if (typeof window === "undefined" || typeof Notification === "undefined") return "unsupported";
  try {
    return Notification.permission;
  } catch {
    return "unsupported";
  }
}

// Exposed as an external store so the page can read the permission through
// useSyncExternalStore: the prerendered HTML has no Notification object, so
// reading it during the first render is a hydration mismatch, and the only
// moment it changes inside a session is the prompt resolving below.
const listeners = new Set<() => void>();

export function subscribeNotify(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function notifyStateServer(): NotifyState {
  return "unsupported";
}

/** Call only from a user gesture. Resolves to the state after the prompt. */
export async function requestNotifyPermission(): Promise<NotifyState> {
  if (notifyState() === "unsupported") return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  } finally {
    for (const l of listeners) l();
  }
}

/**
 * Deliver one fired alert. Returns whether the constructor took it — which
 * is delivery to the OS, not proof a human saw anything; the inbox is the
 * record, this is the tap on the shoulder.
 */
export function deliverNotification(e: LiveAlertEvent): boolean {
  // One OS card per alert id even if a pass re-delivers.
  return show(e.headline, `${e.measurement}\n${e.detail}`, e.id);
}

/**
 * The radar's two loud moments — a proven wallet buying, and that wallet
 * selling — go to the OS the same way a fired rule does, so a copier who
 * tabbed away still hears them inside the seconds that matter.
 */
export function deliverRadarNotification(headline: string, body: string, tag: string): boolean {
  return show(headline, body, tag);
}

function show(title: string, body: string, tag: string): boolean {
  if (notifyState() !== "granted") return false;
  try {
    const n = new Notification(title, {
      body,
      tag,
      silent: false,
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* focus can be refused; the click still dismisses */
      }
    };
    return true;
  } catch {
    return false;
  }
}
