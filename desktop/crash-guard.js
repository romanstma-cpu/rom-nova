// What to do about a renderer that died.
//
// A dead renderer leaves the frame standing with nothing inside it: no page,
// no error, nothing to click. Reloading is the right answer for a death that
// happens once — the GPU process resetting under the 3D network scene, a tab
// pushed out of memory on a machine that ran out — and the wrong answer for a
// page that dies every time it loads, where reloading is the only thing the
// shell would ever do again.
//
// The guard this replaces lived inline in main.js and told the two apart with
// a stopwatch: it refused a second reload within a minute of the last one.
// That bounds the RATE and nothing else, so a page that crashed sixty seconds
// into every load reloaded once a minute for as long as the window stayed
// open — a slower loop than the one its comment promised could not happen,
// but a loop, and no test ever said otherwise because main.js takes Electron
// at the top level and cannot be imported.
//
// A finished load is the signal the stopwatch was standing in for. Reloads
// are counted since the last one, and a renderer that stayed up steadyMs
// before it died has its count forgiven: that page loaded, the reader used
// it, and whatever killed it is an incident rather than a page that cannot
// start.
//
// A plain object over injected values, so the test needs no Electron.

/** How many times a renderer that never settles is brought back. */
const MAX_RELOADS = 3;

/** How long a renderer must have been up for its death to count as an incident. */
const STEADY_MS = 60_000;

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.maxReloads]
 * @param {number} [options.steadyMs]
 */
function createCrashGuard({ now = Date.now, maxReloads = MAX_RELOADS, steadyMs = STEADY_MS } = {}) {
  // null while nothing has finished loading since the last death. The
  // sentinel is not 0, because a test's injected clock may start there.
  let loadedAt = null;
  let reloads = 0;

  return {
    /** A load that finished: this page is at least able to start. */
    loaded() {
      loadedAt = now();
    },

    /**
     * What the shell should do about Electron's `render-process-gone`.
     *
     * @param {{reason?: string} | undefined} details  Electron's second argument
     * @returns {"reload" | "ignore"}
     */
    crashed(details) {
      const reason = details && details.reason;
      // A renderer the app or the OS ended on purpose is not a crash: the
      // window is closing, or something took the process down deliberately.
      if (reason === "clean-exit" || reason === "killed") return "ignore";
      if (loadedAt !== null && now() - loadedAt >= steadyMs) reloads = 0;
      loadedAt = null;
      if (reloads >= maxReloads) return "ignore";
      reloads += 1;
      return "reload";
    },
  };
}

module.exports = { MAX_RELOADS, STEADY_MS, createCrashGuard };
