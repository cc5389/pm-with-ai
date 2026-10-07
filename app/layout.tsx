import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Orchestra · Intelligent model routing",
  description:
    "A transparent workspace for routing AI requests within quality, latency, and budget constraints.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
