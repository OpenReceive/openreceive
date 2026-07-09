/**
 * Umbrella package entry. Prefer a subpath for the surface you need:
 *
 * - `openreceive/node` — server SDK
 * - `openreceive/express` | `openreceive/fastify` | `openreceive/next` — route adapters
 * - `openreceive/browser` | `openreceive/react` | `openreceive/vue` | … — checkout UI
 * - `openreceive/contracts` — generated contract constants
 *
 * Framework UI packages are optional peer dependencies; install only the one you use.
 */
export type {
  OpenReceive,
  Checkout,
  CreateCheckoutRequest,
  Order,
} from "@openreceive/node";
export { createOpenReceive, OpenReceiveConfigError, OpenReceiveServiceError } from "@openreceive/node";
