import type { NextConfig } from "next";

// Sent with every response. The app never needs to be framed, sniffed or handed a camera, so
// each of these closes a door it doesn't use: clickjacking (frame-ancestors / X-Frame-Options),
// MIME sniffing, referrers leaking paths to other sites, powerful browser features, and plain
// HTTP (HSTS; browsers ignore it on http://localhost, so dev is unaffected).
//
// The CSP deliberately stops short of script-src: the App Router streams its payload in inline
// scripts, so a script policy needs per-request nonces (proxy.ts) to mean anything. The app
// renders no raw HTML, which is what a script policy would be guarding against.
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  reactCompiler: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
