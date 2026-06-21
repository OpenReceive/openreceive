import type {
  ExpressLikeHandler,
  ExpressLikeRequest,
  ExpressLikeResponse,
  OpenReceiveExpressHandlers
} from "@openreceive/express";
import {
  InMemoryInvoiceEventBus,
  createOpenReceiveExpressHandlers
} from "@openreceive/express";
import {
  createDefaultLivePriceProviders,
  type OpenReceiveInvoiceStore
} from "@openreceive/core";
import {
  createAlbyNwcReceiveClient
} from "@openreceive/node";
import {
  createHelloFruitDemoMetadata
} from "../../../../shared/demo-metadata.ts";
import {
  createHelloFruitOpenReceiveLogger
} from "../../../../shared/demo-logging.ts";
import {
  createHelloFruitOpenReceiveInvoiceStore
} from "../../../../shared/openreceive-store.ts";

const DEMO_ID = "nextjs-fullstack";
const DEFAULT_PORT = "3002";
const GITHUB_REPOSITORY_URL = "https://github.com/openreceive/openreceive";

interface NextDemoRuntime {
  readonly connectionString: string;
  readonly store: OpenReceiveInvoiceStore;
  readonly eventBus: InMemoryInvoiceEventBus;
  readonly handlers: OpenReceiveExpressHandlers;
}

let runtime: NextDemoRuntime | undefined;

export function isWalletConfigured(): boolean {
  return getConnectionString() !== undefined;
}

export function demoMetadataResponse(): Response {
  return jsonResponse(createHelloFruitDemoMetadata({
    id: DEMO_ID,
    walletConfigured: isWalletConfigured(),
    requestedMode: process.env.OPENRECEIVE_DEMO_MODE,
    gitSha: process.env.OPENRECEIVE_GIT_SHA,
    imageDigest: process.env.OPENRECEIVE_IMAGE_DIGEST,
    deployedAt: process.env.OPENRECEIVE_DEPLOYED_AT,
    packages: {
      "@openreceive/browser": "0.1.0",
      "@openreceive/react": "0.1.0",
      "next": "0.1.0-demo"
    }
  }));
}

export function healthzResponse(): Response {
  return jsonResponse({
    ok: true,
    demo: DEMO_ID,
    wallet_configured: isWalletConfigured()
  });
}

export function sourceRedirectResponse(): Response {
  return Response.redirect(
    `${GITHUB_REPOSITORY_URL}/tree/main/examples/hello-fruit/server/nextjs-fullstack`,
    302
  );
}

export function docsRedirectResponse(): Response {
  return Response.redirect(
    `${GITHUB_REPOSITORY_URL}/blob/main/docs/05-frontend-checkout.md`,
    302
  );
}

export function robotsResponse(): string {
  if (process.env.OPENRECEIVE_DEMO_NOINDEX === "1") {
    return "User-agent: *\nDisallow: /\n";
  }

  return `User-agent: *\nAllow: /\nSitemap: ${publicUrl()}/sitemap.xml\n`;
}

export function sitemapResponse(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${escapeXml(publicUrl())}/</loc></url>`,
    "</urlset>",
    ""
  ].join("\n");
}

export async function dispatchOpenReceiveHandler(
  name: keyof OpenReceiveExpressHandlers,
  request: Request,
  params: Record<string, string | undefined> = {}
): Promise<Response> {
  const connectionString = getConnectionString();
  if (connectionString === undefined) {
    return noWalletResponse(name);
  }

  const nextRuntime = getRuntime(connectionString);
  const handler = nextRuntime.handlers[name] as ExpressLikeHandler;
  const req = await createExpressLikeRequest(request, params);
  const res = new CapturedResponse();
  let nextError: unknown;

  await handler(req, res, (error?: unknown) => {
    nextError = error;
  });

  if (nextError !== undefined) {
    throw nextError;
  }

  return res.toResponse();
}

export async function invoiceEventsResponse(
  request: Request,
  invoiceId: string
): Promise<Response> {
  const connectionString = getConnectionString();
  if (connectionString === undefined) {
    return noWalletResponse("invoiceEvents");
  }

  const nextRuntime = getRuntime(connectionString);
  const invoice = await nextRuntime.store.getInvoice(invoiceId);
  if (invoice === undefined) {
    return jsonResponse({
      code: "NOT_FOUND",
      message: `Invoice not found: ${invoiceId}`
    }, 404);
  }

  const encoder = new TextEncoder();
  const lastEventId = parseLastEventId(request.headers.get("last-event-id"));
  let cleanupStream = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let cleanedUp = false;
      const writeEvent = (event: {
        readonly id: number;
        readonly event: string;
        readonly data: Record<string, unknown>;
      }) => {
        controller.enqueue(encoder.encode(formatSseEvent(event.id, event.event, event.data)));
      };

      for (const event of nextRuntime.eventBus.replay(invoiceId, lastEventId)) {
        writeEvent(event);
      }

      const unsubscribe = nextRuntime.eventBus.subscribe(invoiceId, writeEvent);
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 20000);

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(heartbeat);
        unsubscribe();
        request.signal.removeEventListener("abort", cleanup);
      };

      cleanupStream = cleanup;
      request.signal.addEventListener("abort", cleanup, { once: true });
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

function getRuntime(connectionString: string): NextDemoRuntime {
  if (runtime !== undefined && runtime.connectionString === connectionString) {
    return runtime;
  }

  const store = createHelloFruitOpenReceiveInvoiceStore({
    demoId: DEMO_ID
  });
  const eventBus = new InMemoryInvoiceEventBus();
  const client = createAlbyNwcReceiveClient({
    connectionString
  });

  runtime = {
    connectionString,
    store,
    eventBus,
    handlers: createOpenReceiveExpressHandlers({
      client,
      store,
      eventBus,
      merchantScope: () => "demo:hello-fruit-nextjs",
      priceProviders: createDefaultLivePriceProviders({ currencies: ["USD"] }),
      priceCurrencies: ["USD"],
      unsafeAllowUnauthenticatedDemoMode: true,
      logger: createHelloFruitOpenReceiveLogger(DEMO_ID)
    })
  };

  return runtime;
}

async function createExpressLikeRequest(
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
    body: await readRequestBody(request)
  };
}

async function readRequestBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const text = await request.text();
  if (text.length === 0) return undefined;
  return JSON.parse(text);
}

function noWalletResponse(name: keyof OpenReceiveExpressHandlers): Response {
  if (name === "health") {
    return jsonResponse({
      ok: true,
      wallet_configured: false
    });
  }

  if (name === "capabilities") {
    return jsonResponse({
      base_path: "/openreceive/v1",
      wallet_configured: false,
      transports: ["sse"],
      methods: ["make_invoice", "lookup_invoice"]
    });
  }

  return jsonResponse({
    code: "WALLET_UNAVAILABLE",
    message: "Set OPENRECEIVE_NWC before creating live invoices."
  }, 503);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "Referrer-Policy": "same-origin"
    }
  });
}

class CapturedResponse implements ExpressLikeResponse {
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

function getConnectionString(): string | undefined {
  const value = process.env.OPENRECEIVE_NWC;
  return value === undefined || value.length === 0 ? undefined : value;
}

function parseLastEventId(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function formatSseEvent(
  id: number,
  event: string,
  data: Record<string, unknown>
): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function publicUrl(): string {
  const configured = process.env.OPENRECEIVE_PUBLIC_URL;
  if (configured !== undefined) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        parsed.hash = "";
        parsed.search = "";
        return parsed.toString().replace(/\/$/, "");
      }
    } catch {
      return `http://localhost:${DEFAULT_PORT}`;
    }
  }

  return `http://localhost:${DEFAULT_PORT}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
