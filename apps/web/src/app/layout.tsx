import type { Metadata } from "next";
import { IBM_Plex_Mono, Plus_Jakarta_Sans } from "next/font/google";
import { BRAND_FULL_NAME, BRAND_NAME } from "@/components/ui/Brand";
import "./globals.css";

// Two faces, each with one job:
//   Plus Jakarta Sans  everything read: headings, tables, controls -- the
//                      ui-ux-pro-max pairing for SaaS dashboards and B2B tools
//   Plex Mono          line numbers and tag numbers, which are identifiers
const uiSans = Plus_Jakarta_Sans({
  variable: "--font-ui",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: { default: `${BRAND_NAME} — ${BRAND_FULL_NAME}`, template: `%s · ${BRAND_NAME}` },
  description: "Cross-document engineering review: P&ID, ISO, hook-up and cutting drawings extracted and checked against each other.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${uiSans.variable} ${plexMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
