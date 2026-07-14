/**
 * Server-only Hello Fruit delivery gate. Serves purchased sticker bytes only when
 * `onPaid` has marked the order summary paid and the caller presents a valid
 * per-order capability token. Do not import from browser clients.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createHostOrderStore,
  createOrderAccessTokenManager,
  type HostOrderMetaStore,
} from "@openreceive/node";
import { extractToken } from "@openreceive/http";
import type { Request as ExpressRequest, Response as ExpressResponse, Express } from "express";
import { isHelloFruitDemoOrder, type HelloFruitDemoOrder } from "./demo-order.ts";

const PRODUCT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export interface ResolveHelloFruitDeliveryInput {
  readonly store: HostOrderMetaStore;
  readonly stickersDir: string;
  readonly orderId: string;
  readonly productId: string;
  /** Fetch API Request (Next) or headers bag used to build one (Express). */
  readonly request: Request;
}

export type ResolveHelloFruitDeliveryResult =
  | {
      readonly ok: true;
      readonly bytes: Buffer;
      readonly filename: string;
      readonly contentType: "image/svg+xml";
    }
  | { readonly ok: false; readonly status: 401 | 403 | 404; readonly message: string };

/**
 * Authorize and load a purchased sticker. Catalog `/stickers` assets stay public for browsing;
 * this path is the post-pay deliverable.
 */
export async function resolveHelloFruitDelivery(
  input: ResolveHelloFruitDeliveryInput,
): Promise<ResolveHelloFruitDeliveryResult> {
  const orderId = input.orderId.trim();
  const productId = input.productId.trim();
  if (orderId.length === 0 || !PRODUCT_ID_PATTERN.test(productId)) {
    return { ok: false, status: 404, message: "Not found." };
  }

  const token = extractToken(input.request);
  if (token === null) {
    return { ok: false, status: 401, message: "Order access token required." };
  }

  const tokens = createOrderAccessTokenManager(input.store);
  const tokenValid = await tokens.verify(orderId, token);
  if (!tokenValid) {
    return { ok: false, status: 403, message: "Not authorized to download this order." };
  }

  const hostOrders = createHostOrderStore<HelloFruitDemoOrder>(input.store);
  const stored = await hostOrders.read(orderId);
  if (stored === null || !isHelloFruitDemoOrder(stored.summary)) {
    return { ok: false, status: 404, message: "Order not found." };
  }
  if (stored.summary.status !== "paid") {
    return { ok: false, status: 403, message: "Order is not fulfilled yet." };
  }

  const item = stored.summary.items.find((entry) => entry.product_id === productId);
  if (item === undefined) {
    return { ok: false, status: 404, message: "Product not on this order." };
  }

  const stickerFile = path.basename(item.sticker);
  if (!stickerFile.endsWith(".svg") || stickerFile.includes("..")) {
    return { ok: false, status: 404, message: "Sticker not found." };
  }
  const stickersRoot = path.resolve(input.stickersDir);
  const absolute = path.resolve(stickersRoot, stickerFile);
  if (!absolute.startsWith(`${stickersRoot}${path.sep}`) && absolute !== stickersRoot) {
    return { ok: false, status: 404, message: "Sticker not found." };
  }

  try {
    const bytes = readFileSync(absolute);
    return {
      ok: true,
      bytes,
      filename: `${productId}-sticker.svg`,
      contentType: "image/svg+xml",
    };
  } catch {
    return { ok: false, status: 404, message: "Sticker not found." };
  }
}

/** Fetch Response for App Router / undici-style handlers. */
export async function helloFruitDeliveryFetchResponse(
  input: ResolveHelloFruitDeliveryInput,
): Promise<Response> {
  const result = await resolveHelloFruitDelivery(input);
  if (!result.ok) {
    return new Response(result.message, { status: result.status });
  }
  return new Response(new Uint8Array(result.bytes), {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": result.contentType,
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    },
  });
}

export interface MountHelloFruitDeliveryOptions {
  readonly store: HostOrderMetaStore;
  readonly stickersDir: string;
}

/** Mount `GET /delivery/:orderId/:productId` on an Express app. */
export function mountHelloFruitDelivery(app: Express, options: MountHelloFruitDeliveryOptions): void {
  app.get("/delivery/:orderId/:productId", async (req, res, next) => {
    try {
      await sendHelloFruitDeliveryExpress(req, res, options);
    } catch (error) {
      next(error);
    }
  });
}

async function sendHelloFruitDeliveryExpress(
  req: ExpressRequest,
  res: ExpressResponse,
  options: MountHelloFruitDeliveryOptions,
): Promise<void> {
  const orderId = String(req.params.orderId ?? "");
  const productId = String(req.params.productId ?? "");
  const host = req.get("host") ?? "localhost";
  const proto = req.protocol || "http";
  const request = new Request(`${proto}://${host}${req.originalUrl}`, {
    method: "GET",
    headers: expressHeadersToFetch(req),
  });
  const result = await resolveHelloFruitDelivery({
    store: options.store,
    stickersDir: options.stickersDir,
    orderId,
    productId,
    request,
  });
  if (!result.ok) {
    res.status(result.status).type("text/plain").send(result.message);
    return;
  }
  res
    .status(200)
    .set({
      "Cache-Control": "private, no-store",
      "Content-Type": result.contentType,
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    })
    .send(result.bytes);
}

function expressHeadersToFetch(req: ExpressRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}
