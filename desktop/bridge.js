// The renderer's one window onto the shell: which version this is, and
// whether an update is waiting.
//
// WHY A PATH AND NOT A PRELOAD
//
// The page has no way to know it is running inside the installer rather than
// a browser tab, so it could not show its version, could not say "an update
// is downloaded, restart to install", and could not offer the restart. The
// usual answer is a preload script and an IPC channel. This shell has neither
// on purpose — sandbox on, context isolation on, nothing exposed — and the
// RPC proxy already showed the cheaper way: a request the renderer makes to
// its OWN origin is same-origin, `protocol.handle` intercepts it here, and no
// privilege changes hands.
//
// SECURITY
//
// Only a page served from app://rom-nova can reach these paths: the protocol
// handler refuses every other host before this file is asked. The GET answers
// with nothing secret (the version is printed on the installer). The two
// POSTs do one thing each — ask the updater to look, or restart into an
// update that is ALREADY downloaded and verified by electron-updater — and
// nothing in the request body is read at all.

const BRIDGE_PATH = "/nova/__desktop";
const INSTALL_PATH = "/nova/__desktop/install";
const CHECK_PATH = "/nova/__desktop/check";

/** Whether this request is for the shell rather than for a static file. */
function isBridgeRequest(pathname) {
  return pathname === BRIDGE_PATH || pathname === INSTALL_PATH || pathname === CHECK_PATH;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Builds the bridge over injected dependencies, so the unit test can drive it
 * with a fake updater and no Electron at all.
 *
 * @param {object} deps
 * @param {() => string} deps.version         `app.getVersion`
 * @param {string} deps.platform              `process.platform`
 * @param {string} deps.arch                  `process.arch`
 * @param {{electron?: string, chrome?: string}} [deps.versions]  `process.versions`
 * @param {object} [deps.updater]             electron-updater's `autoUpdater`; absent when not packaged
 * @param {() => number} [deps.now]
 */
function createBridge({ version, platform, arch, versions, updater, now = Date.now }) {
  // The update state the renderer reads. "unavailable" is the unpackaged dev
  // shell, where there is no feed to check; "idle" is packaged and not yet
  // asked; the rest follow electron-updater's events one to one.
  const update = {
    state: updater ? "idle" : "unavailable",
    version: null,
    percent: null,
    error: null,
    checkedAt: null,
    changedAt: now(),
  };
  const set = (patch) => Object.assign(update, patch, { changedAt: now() });

  if (updater) {
    updater.on("checking-for-update", () => set({ state: "checking", error: null }));
    updater.on("update-available", (info) =>
      set({ state: "available", version: info?.version ?? null, percent: 0, checkedAt: now() }),
    );
    updater.on("update-not-available", (info) =>
      set({ state: "none", version: info?.version ?? null, checkedAt: now() }),
    );
    updater.on("download-progress", (p) =>
      set({ state: "downloading", percent: typeof p?.percent === "number" ? Math.round(p.percent) : null }),
    );
    updater.on("update-downloaded", (info) =>
      set({ state: "ready", version: info?.version ?? null, percent: 100 }),
    );
    // Recorded, not shown as a dialog: an unreachable update feed is the
    // reader's Wi-Fi, not the app's problem, and the Settings page says so
    // in one line if they go looking.
    updater.on("error", (err) =>
      set({ state: "error", error: String((err && err.message) || err || "update check failed"), checkedAt: now() }),
    );
  }

  /** What the renderer sees. A copy, so a caller cannot reach in. */
  function snapshot() {
    return {
      version: version(),
      platform,
      arch,
      electron: (versions && versions.electron) || null,
      chrome: (versions && versions.chrome) || null,
      update: { ...update },
    };
  }

  /**
   * Whether a periodic check should run now. Only from rest: never over a
   * check, a download that is about to start or running, or a finished one —
   * re-checking a downloaded update makes electron-updater announce it again.
   */
  function shouldCheck() {
    return Boolean(updater) && (update.state === "idle" || update.state === "none" || update.state === "error");
  }

  async function handle(request) {
    const { pathname } = new URL(request.url);
    if (pathname === BRIDGE_PATH) {
      if (request.method !== "GET") return json({ error: "GET only" }, 405);
      return json(snapshot());
    }
    if (pathname === CHECK_PATH) {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      if (!updater) return json({ error: "this build has no update feed", update: { ...update } }, 409);
      if (!shouldCheck()) return json({ ok: true, update: { ...update } });
      // The result arrives as events; the renderer polls the GET for them.
      Promise.resolve()
        .then(() => updater.checkForUpdates())
        .catch(() => {
          /* reported through the "error" event above */
        });
      return json({ ok: true, update: { ...update } });
    }
    if (pathname === INSTALL_PATH) {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      if (!updater || update.state !== "ready") {
        return json({ error: "no update is downloaded and ready to install", update: { ...update } }, 409);
      }
      // Answer first, then quit: the renderer gets its 200 before the window
      // goes away, so a failed fetch there always means a failed install.
      setTimeout(() => updater.quitAndInstall(), 60);
      return json({ ok: true, installing: update.version });
    }
    return json({ error: "not found" }, 404);
  }

  return { handle, snapshot, shouldCheck, update };
}

module.exports = { BRIDGE_PATH, INSTALL_PATH, CHECK_PATH, isBridgeRequest, createBridge };
