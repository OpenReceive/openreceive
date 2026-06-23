import type {
  OpenReceiveLogEntry,
  OpenReceiveLogger
} from "@openreceive/node";

export function createHelloFruitOpenReceiveLogger(
  demoId: string
): OpenReceiveLogger {
  return (entry: OpenReceiveLogEntry) => {
    const { level, event, message, ...fields } = entry;
    const method = level === "error"
      ? "error"
      : level === "warn"
        ? "warn"
        : level === "debug"
          ? "debug"
          : "info";

    console[method](`[openreceive:${demoId}] ${event}: ${message}`, fields);
  };
}
