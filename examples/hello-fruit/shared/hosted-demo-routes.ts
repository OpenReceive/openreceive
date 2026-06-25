import type { Express } from "express";

export interface HelloFruitHostedDemoRoutesInput {
  readonly id: string;
  readonly sourcePath: string;
  readonly docsPath: string;
  readonly walletConfigured: boolean;
  readonly defaultPort: string;
}

const GITHUB_REPOSITORY_URL = "https://github.com/openreceive/openreceive";

export function mountHelloFruitHostedDemoRoutes(
  app: Express,
  input: HelloFruitHostedDemoRoutesInput
): void {
  app.get("/source", (_req, res) => {
    res.redirect(302, `${GITHUB_REPOSITORY_URL}/tree/main/${input.sourcePath}`);
  });

  app.get("/docs", (_req, res) => {
    res.redirect(302, `${GITHUB_REPOSITORY_URL}/blob/main/${input.docsPath}`);
  });

  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send(robotsTxt(publicUrl(input.defaultPort)));
  });

  app.get("/sitemap.xml", (_req, res) => {
    res.type("application/xml").send(sitemapXml(publicUrl(input.defaultPort)));
  });
}

function robotsTxt(baseUrl: string): string {
  if (process.env.OPENRECEIVE_DEMO_NOINDEX === "1") {
    return "User-agent: *\nDisallow: /\n";
  }

  return `User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\n`;
}

function sitemapXml(baseUrl: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${escapeXml(baseUrl)}/</loc></url>`,
    "</urlset>",
    ""
  ].join("\n");
}

function publicUrl(defaultPort: string): string {
  const configured = process.env.OPENRECEIVE_PUBLIC_URL;
  if (configured !== undefined) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        parsed.hash = "";
        parsed.search = "";
        return parsed.toString().replace(/\/$/, "");
      }
    } catch {
      return `http://localhost:${defaultPort}`;
    }
  }

  return `http://localhost:${defaultPort}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
