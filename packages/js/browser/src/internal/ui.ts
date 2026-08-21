// Barrel for the browser's UI vocabulary. Every consumer imports from here;
// the pieces live in the four modules below.
export * from "./checkout-types.ts";
export * from "./dom-contract.ts";
export * from "./icons.ts";
export * from "./labels.ts";
export { type Status, type StatusInvoiceLike, status } from "../status.ts";
