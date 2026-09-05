// The version this build IS.
//
// Stamped at build time from desktop/package.json — the one version the
// release drill bumps — through NEXT_PUBLIC_APP_VERSION in next.config.ts,
// so the web build at romapps.xyz/nova and the installer built from the same
// export say the same number. "dev" only if the file could not be read.
// Nothing in the app had a version string before this; a reader reporting a
// problem could not say which build they were looking at.
export const APP_VERSION: string = process.env.NEXT_PUBLIC_APP_VERSION || "dev";

export const SOURCE_URL = "https://github.com/romanstma-cpu/rom-nova";
export const RELEASES_URL = "https://github.com/romanstma-cpu/rom-nova/releases";
/** GitHub's stable alias for the newest release's installer. */
export const INSTALLER_URL = "https://github.com/romanstma-cpu/rom-nova/releases/latest/download/ROM-Nova-Setup.exe";
export const API_DOCS_URL = "https://github.com/romanstma-cpu/rom-nova/blob/main/worker/API.md";
export const SITE_URL = "https://romapps.xyz";
