import type { NextConfig } from "next";

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
  },
  ...(isStatic
    ? {}
    : {
        headers: async () => [{ source: "/:path*", headers: securityHeaders }],
      }),
};

export default nextConfig;
