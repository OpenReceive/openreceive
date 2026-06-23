import type {
  OpenReceiveBrowserLogEntry,
  OpenReceiveBrowserLogger
} from "@openreceive/browser/internal";

export function createHelloFruitBrowserLogger(
  demoId: string
): OpenReceiveBrowserLogger {
  return (entry: OpenReceiveBrowserLogEntry) => {
    const { level, event, message, ...fields } = entry;
    const method = level === "error"
      ? "error"
      : level === "warn"
        ? "warn"
        : level === "debug"
          ? "debug"
          : "info";

    console[method](`[openreceive:${demoId}:client] ${event}: ${message}`, fields);
  };
}
