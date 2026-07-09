import type { LogEntry, Logger } from "@openreceive/node";

export function createHelloFruitOpenReceiveLogger(demoId: string): Logger {
  return (entry: LogEntry) => {
    const { level, event, message, ...fields } = entry;
    if (level === "debug") return;

    const method =
      level === "error"
        ? "error"
        : level === "warn"
          ? "warn"
          : "info";

    console[method](
      `[openreceive:${demoId}] ${event}: ${message}`,
      stripUndefinedLogFields(fields),
    );
  };
}

export function createHelloFruitDemoServerLogger(demoId: string) {
  return (event: string, message: string, fields: Record<string, unknown> = {}): void => {
    console.log(`[hello-fruit:${demoId}:server] ${event}: ${message}`, {
      at: new Date().toISOString(),
      ...stripUndefinedLogFields(fields),
    });
  };
}

function stripUndefinedLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      clean[key] = value.map((entry) =>
        isPlainLogRecord(entry) ? stripUndefinedLogFields(entry as Record<string, unknown>) : entry,
      );
      continue;
    }
    clean[key] = isPlainLogRecord(value)
      ? stripUndefinedLogFields(value as Record<string, unknown>)
      : value;
  }
  return clean;
}

function isPlainLogRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
