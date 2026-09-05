// What a broken page says, and what a reader copies to report it.
//
// Pure functions over the error and a few facts about the build, so the
// boundary components stay thin and this stays testable.

export interface ErrorLike {
  name?: string;
  message?: string;
  stack?: string;
  digest?: string;
}

export interface ErrorReportInput {
  error: ErrorLike | null | undefined;
  version: string;
  /** Path and query of the page that broke; never the hash (a magic-link session could ride there). */
  path: string;
  userAgent: string;
  at: Date;
  desktop?: boolean;
}

/** How many stack lines a report carries: enough to place the fault, not a novel. */
const STACK_LINES = 12;

/**
 * The text behind "copy details": one block a reader can paste into an
 * issue. It names the build, the page, the time and the browser, then the
 * error and the top of its stack. Nothing from storage, nothing typed into
 * the app, no session.
 */
export function errorReport(input: ErrorReportInput): string {
  const e = input.error ?? {};
  const lines = [
    `ROM Nova ${input.version}${input.desktop ? " (desktop)" : " (web)"}`,
    `page: ${stripHash(input.path)}`,
    `when: ${input.at.toISOString()}`,
    `browser: ${input.userAgent}`,
    `error: ${e.name || "Error"}: ${e.message || "(no message)"}`,
  ];
  if (e.digest) lines.push(`digest: ${e.digest}`);
  const stack = (e.stack ?? "")
    .split("\n")
    .map((s) => s.trimEnd())
    .filter((s) => s.length > 0)
    .slice(0, STACK_LINES);
  // The first stack line repeats the message; only the frames add anything.
  if (stack.length > 1) lines.push("", ...stack);
  return lines.join("\n");
}

function stripHash(path: string): string {
  const i = path.indexOf("#");
  return i === -1 ? path : path.slice(0, i);
}

export interface ErrorDescription {
  title: string;
  advice: string;
  /** Whether reloading the page is the likely fix, so the boundary offers it first. */
  reload: boolean;
}

/**
 * A plain-words reading of the error, for the boundary's first two lines.
 *
 * The one case worth telling apart is a chunk that failed to load: after a
 * release, a tab opened before it still asks for the old build's files, and
 * the static host no longer has them. That is not a bug in the page and a
 * reload cures it. Everything else is "this page broke", with the message
 * shown under it and the rest of the app one click away.
 */
export function describeError(error: ErrorLike | null | undefined): ErrorDescription {
  const msg = `${error?.name ?? ""} ${error?.message ?? ""}`;
  if (/ChunkLoadError|Loading chunk|dynamically imported module|Failed to fetch dynamically|Importing a module script failed/i.test(msg)) {
    return {
      title: "A part of the app failed to load",
      advice:
        "This usually means the app was updated while this tab was open, and the tab is asking for files the old build had. Reloading brings in the current build; nothing you keep in this browser is affected.",
      reload: true,
    };
  }
  if (/WebGL|Error creating WebGL context|THREE\.WebGLRenderer/i.test(msg)) {
    return {
      title: "This page needs 3D graphics the browser could not provide",
      advice:
        "WebGL is off or unavailable here — common over remote desktop, in some virtual machines, and in hardened browser profiles. Every other page works without it.",
      reload: false,
    };
  }
  return {
    title: "This page hit an error it could not recover from",
    advice:
      "The rest of the app is fine — the rail, the search and every other page still work. Try again re-renders this page; if it breaks the same way twice, copy the details and report them with what you were doing.",
    reload: false,
  };
}
