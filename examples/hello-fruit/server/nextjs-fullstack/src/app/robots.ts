import type { MetadataRoute } from "next";
import {
  robotsResponse
} from "../server/openreceive.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function robots(): MetadataRoute.Robots {
  const text = robotsResponse();
  if (text.includes("Disallow: /")) {
    return {
      rules: {
        userAgent: "*",
        disallow: "/"
      }
    };
  }

  return {
    rules: {
      userAgent: "*",
      allow: "/"
    },
    sitemap: text.match(/Sitemap: (.+)/)?.[1]
  };
}
