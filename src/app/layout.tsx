import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { ServiceWorker } from "@/components/ServiceWorker";

// Self-hosted: the same Latin variable files Google Fonts serves (licence in ./fonts/OFL.txt), so a
// build never fetches fonts. next/font/google failed the whole Turbopack build whenever Google
// answered with /l/font?kit=…&skey=… URLs (vercel/next.js#99114). Same weight ranges as before.
const geistSans = localFont({ src: "./fonts/geist-latin.woff2", variable: "--font-geist-sans", weight: "400 900", display: "swap" });
const geistMono = localFont({ src: "./fonts/geist-mono-latin.woff2", variable: "--font-geist-mono", weight: "400 700", display: "swap" });

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "East London Roundnet",
  description: "Our roundnet ladder. Log games, see where you stand.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Roundnet" },
  openGraph: {
    type: "website",
    siteName: "East London Roundnet",
    title: "East London Roundnet",
    description: "Our roundnet ladder. Log games, see where you stand.",
  },
  twitter: {
    card: "summary_large_image",
    title: "East London Roundnet",
    description: "Our roundnet ladder. Log games, see where you stand.",
  },
};

export const viewport: Viewport = {
  themeColor: "#0c0e10",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
