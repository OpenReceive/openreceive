import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const configured = process.env.OPENRECEIVE_PUBLIC_URL;
  let url = "http://localhost:3002";

  if (configured !== undefined) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        parsed.hash = "";
        parsed.search = "";
        url = parsed.toString().replace(/\/$/, "");
      }
    } catch {
      url = "http://localhost:3002";
    }
  }

  return [
    {
      url,
      lastModified: new Date("2026-06-20T00:00:00Z")
    }
  ];
}
