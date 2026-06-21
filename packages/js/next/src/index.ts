import type {
  ExpressLikeHandler,
  ExpressLikeRequest,
  ExpressLikeResponse,
  InMemoryInvoiceEventBus,
  OpenReceiveExpressHandlers,
  OpenReceiveExpressOptions
} from "@openreceive/express";
import {
  createOpenReceiveExpressHandlers
} from "@openreceive/express";
import type {
  InvoiceStorageRow,
  OpenReceiveInvoiceStore
} from "@openreceive/core";

export interface OpenReceiveNextRuntime {
  readonly store: OpenReceiveInvoiceStore;
  readonly eventBus: InMemoryInvoiceEventBus;
  readonly handlers: OpenReceiveExpressHandlers;
}

export interface CreateOpenReceiveNextRuntimeOptions
  extends OpenReceiveExpressOptions {
  store: OpenReceiveInvoiceStore;
  eventBus: InMemoryInvoiceEventBus;
}

export interface OpenReceiveNextNoWalletOptions {
  readonly basePath?: string;
  readonly message?: string;
}

export interface DispatchOpenReceiveNextHandlerOptions {
  readonly runtime: OpenReceiveNextRuntime;
  readonly name: keyof OpenReceiveExpressHandlers;
  readonly request: Request;
  readonly params?: Record<string, string | undefined>;
}

export interface DispatchOpenReceiveNextNoWalletHandlerOptions {
  readonly name: keyof OpenReceiveExpressHandlers;
  readonly noWallet?: OpenReceiveNextNoWalletOptions;
}

export interface CreateOpenReceiveNextInvoiceEventsResponseOptions {
  readonly runtime: OpenReceiveNextRuntime;
  readonly request: Request;
  readonly invoiceId: string;
  readonly heartbeatMs?: number;
}

export const OPENRECEIVE_NEXT_DEFAULT_BASE_PATH = "/openreceive/v1";
export const OPENRECEIVE_NEXT_DEFAULT_NO_WALLET_MESSAGE =
  "Set OPENRECEIVE_NWC before creating live invoices.";
export const OPENRECEIVE_NEXT_DEFAULT_HEARTBEAT_MS = 20_000;

export function createOpenReceiveNextRuntime(
  options: CreateOpenReceiveNextRuntimeOptions
): OpenReceiveNextRuntime {
  return {
    store: options.store,
    eventBus: options.eventBus,
    handlers: createOpenReceiveExpressHandlers(options)
  };
}

export async function dispatchOpenReceiveNextHandler(
  options: DispatchOpenReceiveNextHandlerOptions
): Promise<Response> {
  const handler = options.runtime.handlers[options.name] as ExpressLikeHandler;
  const req = await createOpenReceiveNextRequest(
    options.request,
    options.params ?? {}
  );
  const res = new CapturedOpenReceiveNextResponse();
  let nextError: unknown;

  await handler(req, res, (error?: unknown) => {
    nextError = error;
  });

  if (nextError !== undefined) throw nextError;
  return res.toResponse();
}

export function dispatchOpenReceiveNextNoWalletHandler(
  options: DispatchOpenReceiveNextNoWalletHandlerOptions
): Response {
  return createOpenReceiveNextNoWalletResponse(options.name, options.noWallet);
}

export async function createOpenReceiveNextInvoiceEventsResponse(
  options: CreateOpenReceiveNextInvoiceEventsResponseOptions
): Promise<Response> {
  const invoice = await options.runtime.store.getInvoice(options.invoiceId);
  if (invoice === undefined) {
    return openReceiveNextJsonResponse({
      code: "NOT_FOUND",
      message: `Invoice not found: ${options.invoiceId}`
    }, 404);
  }

  return createInvoiceEventStreamResponse({
    invoice,
    eventBus: options.runtime.eventBus,
    request: options.request,
    heartbeatMs: options.heartbeatMs ?? OPENRECEIVE_NEXT_DEFAULT_HEARTBEAT_MS
  });
}

export function createOpenReceiveNextNoWalletResponse(
  name: keyof OpenReceiveExpressHandlers,
  options: OpenReceiveNextNoWalletOptions = {}
): Response {
  const basePath = options.basePath ?? OPENRECEIVE_NEXT_DEFAULT_BASE_PATH;
  const message = options.message ?? OPENRECEIVE_NEXT_DEFAULT_NO_WALLET_MESSAGE;

  if (name === "health") {
    return openReceiveNextJsonResponse({
      ok: true,
      wallet_configured: false
    });
  }

  if (name === "capabilities") {
    return openReceiveNextJsonResponse({
      base_path: basePath,
      wallet_configured: false,
      transports: ["sse"],
      methods: ["make_invoice", "lookup_invoice"]
    });
  }

  return openReceiveNextJsonResponse({
    code: "WALLET_UNAVAILABLE",
    message
  }, 503);
}

export function openReceiveNextJsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = {}
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("Content-Type", "application/json");
  responseHeaders.set("Referrer-Policy", "same-origin");

  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders
  });
}

async function createOpenReceiveNextRequest(
  request: Request,
  params: Record<string, string | undefined>
): Promise<ExpressLikeRequest> {
  const url = new URL(request.url);
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    query[key] = value;
  }

  return {
    method: request.method,
    path: url.pathname,
    params,
    query,
    headers: Object.fromEntries(request.headers.entries()),
    get: (header) => request.headers.get(header) ?? undefined,
    body: await readOpenReceiveNextRequestBody(request)
  };
}

async function readOpenReceiveNextRequestBody(
  request: Request
): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const text = await request.text();
  if (text.length === 0) return undefined;
  return JSON.parse(text);
}

class CapturedOpenReceiveNextResponse implements ExpressLikeResponse {
  #status = 200;
  #headers = new Headers();
  #body: BodyInit | undefined;
  #chunks: string[] = [];

  status(code: number): ExpressLikeResponse {
    this.#status = code;
    return this;
  }

  set(field: string, value: string): ExpressLikeResponse {
    this.#headers.set(field, value);
    return this;
  }

  json(body: unknown): unknown {
    this.#headers.set("Content-Type", "application/json");
    this.#body = JSON.stringify(body);
    return undefined;
  }

  write(chunk: string): unknown {
    this.#chunks.push(chunk);
    return undefined;
  }

  end(): unknown {
    return undefined;
  }

  flushHeaders(): unknown {
    return undefined;
  }

  toResponse(): Response {
    return new Response(this.#body ?? this.#chunks.join(""), {
      status: this.#status,
      headers: this.#headers
    });
  }
}

function createInvoiceEventStreamResponse(input: {
  invoice: InvoiceStorageRow;
  eventBus: InMemoryInvoiceEventBus;
  request: Request;
  heartbeatMs: number;
}): Response {
  const encoder = new TextEncoder();
  let cleanupStream = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let cleanedUp = false;
      const writeEvent = (event: {
        readonly id: number;
        readonly event: string;
        readonly data: Record<string, unknown>;
      }) => {
        controller.enqueue(
          encoder.encode(formatOpenReceiveNextSseEvent(event.id, event.event, event.data))
        );
      };

      for (const event of input.eventBus.replay(
        input.invoice.invoice_id,
        parseOpenReceiveNextLastEventId(input.request.headers.get("last-event-id"))
      )) {
        writeEvent(event);
      }

      const unsubscribe = input.eventBus.subscribe(input.invoice.invoice_id, writeEvent);
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, input.heartbeatMs);

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(heartbeat);
        unsubscribe();
        input.request.signal.removeEventListener("abort", cleanup);
      };

      cleanupStream = cleanup;
      input.request.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      cleanupStream();
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/event-stream",
      "Referrer-Policy": "same-origin"
    }
  });
}

function parseOpenReceiveNextLastEventId(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function formatOpenReceiveNextSseEvent(
  id: number,
  event: string,
  data: Record<string, unknown>
): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
