import type { CreateOpenReceiveOptions } from "@openreceive/node";

/**
 * Non-secret OpenReceive settings shared by the Node examples.
 *
 * Credentials do not belong here. NWC_URI, LSC_URI_PRIMARY, and LSC_URI_BACKUP come from
 * the process environment. LOG_LEVEL (DEBUG|INFO|WARN|ERROR, default INFO) is read by
 * `@openreceive/node` / `@openreceive/browser` console and file loggers automatically.
 */
export const config = {
  priceCurrencies: ["USD"],
  logging: {
    enabled: true,
    directory: "./logs",
    filename: "openreceive.log",
    maxFileSizeMb: 10,
    maxFiles: 5,
  },
} satisfies Pick<CreateOpenReceiveOptions, "priceCurrencies" | "logging">;
