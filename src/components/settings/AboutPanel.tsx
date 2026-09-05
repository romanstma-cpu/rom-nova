"use client";

// Which build this is, where it runs, and whether an update is waiting —
// the panel every installed app has under "About", which this one did not.
//
// In a browser it says so and points at the installer. In the desktop shell
// it reads the bridge: the shell's version, the updater's state in one line,
// and the two buttons that make sense — look now, and restart into a
// downloaded update.

import { useState, useSyncExternalStore } from "react";
import { fmtAgo } from "@/lib/client";
import { API_DOCS_URL, APP_VERSION, INSTALLER_URL, RELEASES_URL, SITE_URL, SOURCE_URL } from "@/lib/version";
import {
  checkDesktopUpdate,
  describeUpdate,
  desktopServerSnapshot,
  desktopSnapshot,
  installDesktopUpdate,
  subscribeDesktop,
} from "@/lib/desktop";

function platformName(p: string): string {
  if (p === "win32") return "Windows";
  if (p === "darwin") return "macOS";
  if (p === "linux") return "Linux";
  return p;
}

export function AboutPanel() {
  const d = useSyncExternalStore(subscribeDesktop, desktopSnapshot, desktopServerSnapshot);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const update = d.update;
  // The shell and the page inside it are built from the same export, so
  // these agree; a disagreement is worth a chip, not silence.
  const shellVersion = d.version && d.version !== APP_VERSION ? d.version : null;
  const canCheck = d.desktop && d.reachable === true && (update.state === "idle" || update.state === "none" || update.state === "error");
  const canInstall = d.desktop && update.state === "ready";

  const act = async (fn: () => Promise<{ ok: boolean; error: string | null }>) => {
    setBusy(true);
    setNote(null);
    const r = await fn();
    if (!r.ok) setNote(r.error);
    setBusy(false);
  };

  return (
    <div className="panel p-3.5 flex flex-col gap-2" id="about">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="panel-title">About</span>
        <span className="text-[13px] font-semibold">
          ROM Nova <span className="num text-[var(--accent)]">{APP_VERSION}</span>
        </span>
        <span className="chip">{d.desktop ? "desktop" : "web"}</span>
        {shellVersion && (
          <span className="chip chip-warn" title="the shell and the pages inside it were built from different versions">
            shell {shellVersion}
          </span>
        )}
      </div>
      <div className="text-[11.5px] dim leading-relaxed">
        {d.desktop ? (
          <>
            Installed app{d.platform ? ` on ${platformName(d.platform)}` : ""}
            {d.electron ? ` · Electron ${d.electron}` : ""}. Updates:{" "}
            <span className={update.state === "ready" ? "text-[var(--accent)]" : update.state === "error" ? "warn" : "text-[var(--text)]"}>
              {describeUpdate(update, d.reachable)}
            </span>
            {update.checkedAt ? <span className="faint"> · checked {fmtAgo(update.checkedAt)}</span> : null}
          </>
        ) : (
          <>
            Running in your browser. The same app installs on Windows:{" "}
            <a className="link" href={INSTALLER_URL}>
              ROM-Nova-Setup.exe
            </a>{" "}
            updates itself, remembers its window, and reaches the full Solana archive the web build cannot. Your browser
            may also offer to install this site as an app; that keeps everything in this browser&apos;s storage.
          </>
        )}
      </div>
      {d.desktop && (
        <div className="flex gap-2 flex-wrap items-center">
          {canInstall && (
            <button type="button" className="btn btn-primary text-[11px]" disabled={busy} onClick={() => void act(installDesktopUpdate)}>
              Restart to install {update.version ?? "the update"}
            </button>
          )}
          {canCheck && (
            <button type="button" className="btn text-[11px]" disabled={busy} onClick={() => void act(checkDesktopUpdate)}>
              Check for updates
            </button>
          )}
          {note && <span className="text-[11px] warn">{note}</span>}
        </div>
      )}
      <div className="flex gap-3 flex-wrap text-[11px]">
        <a className="link" href={RELEASES_URL} target="_blank" rel="noopener">
          release notes
        </a>
        <a className="link" href={SOURCE_URL} target="_blank" rel="noopener">
          source
        </a>
        <a className="link" href={API_DOCS_URL} target="_blank" rel="noopener">
          API
        </a>
        <a className="link" href={SITE_URL} target="_blank" rel="noopener">
          ROM Apps
        </a>
      </div>
    </div>
  );
}
