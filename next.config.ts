import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import path from "node:path";

// The version the app shows is the desktop package's — the one number the
// release drill bumps — stamped into both builds here so the web build and
// the installer made from the same export agree. "dev" only if unreadable.
//
// The root stays process.cwd() because neither __dirname nor import.meta.url
// survives both ways Next loads this file: it is either transpiled to
// CommonJS by SWC or imported through Node's native TS loader, and each of
// those kills one of them. That makes the read silently cwd-dependent, so it
// is a parameter — tests/version-stamp.test.ts drives both branches from a
// directory it controls and checks the stamp below against the package read
// from the test file's own location. Next takes only the default export
// (interopDefault in server/config.js), so the named export changes nothing
// about the config it loads.
export function desktopVersion(root: string = process.cwd()): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "desktop", "package.json"), "utf8")) as { version?: string };
    return pkg.version || "dev";
  } catch {
    return "dev";
  }
}

// Two build modes:
//  - server (default): full Next server with API routes, SSE, middleware.
//  - static (ROMNOVA_STATIC=1): browser-only export for static hosting
//    (romapps.xyz/nova). pageExtensions drops the .ts route handlers so
//    the export contains no server code; the client dispatcher takes over.
const isStatic = process.env.ROMNOVA_STATIC === "1";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  output: isStatic ? "export" : undefined,
  basePath: isStatic ? "/nova" : undefined,
  trailingSlash: isStatic,
  pageExtensions: isStatic ? ["tsx"] : ["tsx", "ts"],
  env: {
    NEXT_PUBLIC_STATIC: isStatic ? "1" : "0",
    NEXT_PUBLIC_APP_VERSION: desktopVersion(),
  },
  ...(isStatic
    ? {}
    : {
        headers: async () => [{ source: "/:path*", headers: securityHeaders }],
      }),
};

export default nextConfig;
