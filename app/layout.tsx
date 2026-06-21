import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AlphaRecover - Recover transparent PNGs from black and white renders",
  description:
    "Recover transparent PNGs from matched black-background and white-background AI images. Free, local, and batch-ready.",
  openGraph: {
    title: "AlphaRecover",
    description: "Recover transparent PNGs from matched black and white AI renders.",
    type: "website"
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f6f8fb"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
