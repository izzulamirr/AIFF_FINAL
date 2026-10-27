import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { BRAND_FULL_NAME, BRAND_NAME } from "@/components/ui/Brand";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
