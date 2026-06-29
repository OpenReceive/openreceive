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

export function createHelloFruitDemoServerLogger(demoId: string) {
  return (
    event: string,
    message: string,
    fields: Record<string, unknown> = {}
  ): void => {
    console.log(`[hello-fruit:${demoId}:server] ${event}: ${message}`, {
      at: new Date().toISOString(),
      ...fields
    });
  };
}
