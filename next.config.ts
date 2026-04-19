import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

function originFromUrl(value: string | undefined) {
  if (!value) {
    return "";
  }
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  async headers() {
    const fenifyModelOrigin = originFromUrl(process.env.NEXT_PUBLIC_FENIFY_MODEL_URL);
    const connectSrc = isDev
      ? `connect-src 'self' blob: data: ws: http://localhost:3000 http://127.0.0.1:3000${fenifyModelOrigin ? ` ${fenifyModelOrigin}` : ""}`
      : `connect-src 'self' blob: data:${fenifyModelOrigin ? ` ${fenifyModelOrigin}` : ""}`;

    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
      "worker-src 'self' blob:",
      connectSrc,
    ].join("; ");

    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
