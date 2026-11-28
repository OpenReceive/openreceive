import { ImageResponse } from "next/og";
import { product, shop } from "@/lib/catalog";

export const alt = `${shop.name}: pay with Bitcoin Lightning`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        gap: 72,
        padding: 88,
        background: "linear-gradient(135deg, #0a0a0a 0%, #1c1206 100%)",
        color: "#ededed",
        fontFamily: "sans-serif",
      }}
    >
      <svg width="300" height="300" viewBox="0 0 240 240" aria-hidden="true">
        <path d="M120 14 211 66.5v105L120 224l-91-52.5v-105Z" fill="#fff" />
        <path d="M120 30 197 74.5v89L120 208l-77-44.5v-89Z" fill="#f7931a" />
        <path d="M131 58 83 128h33l-8 56 49-74h-33l7-52Z" fill="#1a1000" />
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ fontSize: 30, color: "#f7931a", letterSpacing: 2 }}>
          PAY WITH BITCOIN LIGHTNING
        </div>
        <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.05 }}>{shop.name}</div>
        <div style={{ fontSize: 34, color: "#a1a1a1" }}>
          {`${product.name} · Next.js + Postgres · straight to your wallet`}
        </div>
      </div>
    </div>,
    size,
  );
}
