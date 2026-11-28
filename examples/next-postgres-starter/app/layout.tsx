import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import type { ReactNode } from "react";
import { shop } from "@/lib/catalog";
import { BoltMark } from "./art";
import "./globals.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: { default: shop.name, template: `%s · ${shop.name}` },
  description:
    "A Next.js shop that takes bitcoin over Lightning straight into its own wallet, with orders and payments in Postgres.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <a className="skip-link" href="#content">
          Skip to content
        </a>
        <header className="site-header">
          <Link href="/" className="brand">
            <BoltMark />
            <span translate="no">{shop.name}</span>
          </Link>
          <nav aria-label="Project">
            <a href="https://github.com/OpenReceive/openreceive/tree/master/examples/next-postgres-starter">
              Source
            </a>
          </nav>
        </header>
        <main id="content">{children}</main>
        <footer className="site-footer">
          Payments by{" "}
          <a href="https://openreceive.org" translate="no">
            OpenReceive
          </a>
          : bitcoin over Lightning, paid straight into the shop&rsquo;s own wallet.
        </footer>
      </body>
    </html>
  );
}
