// Umbrella subpath: mirrors the adapter's curated public surface (the adapter
// package owns the export list; see tools/validate/check-public-api.mjs), so
// there is one list to keep true, not four. Host-integration internals live on
// the openreceive/http subpath.
export { createOpenReceive } from "@openreceive/node";
export * from "@openreceive/next";
