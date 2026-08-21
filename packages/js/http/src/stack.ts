import { createOpenReceive, type OpenReceive } from "@openreceive/node";
import type { CreateOpenReceiveHttpHandlerOptions, OpenReceiveHttpHandler } from "./handler.ts";
import { createOpenReceiveHttpHandler } from "./handler.ts";
import type {
  CreateOpenReceiveHostDbOptions,
  CreateOpenReceiveHostOptions,
  OpenReceiveSettlementEventHook,
} from "./host-payments.ts";
import { createOpenReceiveHost } from "./host-payments.ts";
import type { OpenReceivePaymentRepository } from "./payment-repository.ts";
import { normalizePrefix } from "./router.ts";
import type { OpenReceiveOrderSettlementHook } from "./sql-payments.ts";

/**
 * The one-factory happy path (T1): five callbacks plus a db handle. The stack
 * builds the service, host, and handler in one call — the composed
 * `{ service, host, ... }` form and every individual piece stay exported for
 * tests and custom repositories.
 *
 * The stack starts NO background process: settlement of abandoned checkouts
 * happens opportunistically when any later OpenReceive call wins the durable
 * reconcile gate (the handler's default `opportunisticReconcile`). Hosts that
 * want push notifications or a poll loop run the optional worker —
 * `startOpenReceiveNotificationWorker` — in a separate process.
 */
export interface CreateOpenReceiveStackOptions<Order = unknown>
  extends Omit<CreateOpenReceiveHttpHandlerOptions, "service" | "host">,
    Omit<CreateOpenReceiveHostDbOptions<Order>, "db" | "onPaid" | "payments"> {
  /** NWC connection string. The stack builds and owns the service (closed by `close()`). */
  readonly nwc?: string;
  /**
   * Prebuilt (or promised) service, for custom service options. The host owns
   * its lifecycle; `close()` will not close it.
   */
  readonly service?: OpenReceive | Promise<OpenReceive>;
  /** Host database handle (default mode). Pair with `onPaid`. */
  readonly db?: CreateOpenReceiveHostDbOptions<Order>["db"];
  /**
   * Settlement hook for either mode. With `db` it receives the per-order
   * `OpenReceiveOrderSettlement` (with `orderId` and the transactional
   * `query`); with a custom `payments` repository it receives the raw
   * `OpenReceiveSettlementEvent`.
   */
  readonly onPaid?: OpenReceiveOrderSettlementHook | OpenReceiveSettlementEventHook;
  /**
   * Custom payment repository (advanced mode) instead of `db`. `onPaid` then
   * receives the raw settlement event; `createOpenReceiveHost` refuses any
   * other combination.
   */
  readonly payments?: OpenReceivePaymentRepository;
}

export interface OpenReceiveStack {
  /**
   * Handler that boots lazily: the first request (and `ready`) awaits service
   * construction. Boot failures surface on `ready` and on every request.
   */
  readonly handler: OpenReceiveHttpHandler;
  /** Resolves when the service and handler are up. */
  readonly ready: Promise<void>;
  /** Closes the service if the stack created it. */
  close(): Promise<void>;
}

export function createOpenReceiveStack<Order = unknown>(
  options: CreateOpenReceiveStackOptions<Order>,
): OpenReceiveStack {
  if ((options.nwc === undefined) === (options.service === undefined)) {
    throw new TypeError("OpenReceive stack requires exactly one of nwc or service.");
  }
  const {
    nwc,
    service,
    db,
    tableName,
    loadOrder,
    amountForOrder,
    onPaid,
    payments,
    clock,
    ...handlerOptions
  } = options;
  // A custom repository reaches the host factory as the repository mode it is;
  // dropping it here used to land in db mode and blame the caller for omitting
  // the very thing they passed.
  const hostOptions = (
    payments === undefined
      ? {
          db,
          ...(tableName === undefined ? {} : { tableName }),
          loadOrder,
          amountForOrder,
          onPaid,
          ...(clock === undefined ? {} : { clock }),
        }
      : {
          payments,
          loadOrder,
          amountForOrder,
          onPaid,
          ...(clock === undefined ? {} : { clock }),
        }
  ) as CreateOpenReceiveHostOptions<Order>;
  const host = createOpenReceiveHost<Order>(hostOptions);
  const prefix = normalizePrefix(options.prefix ?? "/openreceive");

  let ownedService: OpenReceive | undefined;
  const boot: Promise<OpenReceiveHttpHandler> = (async () => {
    const resolved = service !== undefined ? await service : await createOpenReceive({ nwc });
    if (service === undefined) ownedService = resolved;
    return createOpenReceiveHttpHandler({
      ...handlerOptions,
      ...(clock === undefined ? {} : { clock }),
      service: resolved,
      host,
    });
  })();
  // Fail loud at boot even if the host never awaits ready or sends a request;
  // the rejection still surfaces on ready and on every request.
  boot.catch((error) => {
    console.error("OpenReceive stack failed to start:", error);
  });

  const handle = async (request: Request, extras?: { native?: unknown }): Promise<Response> =>
    (await boot)(request, extras);
  const handler = handle as OpenReceiveHttpHandler;
  Object.defineProperties(handler, {
    prefix: { value: prefix, enumerable: true },
    handle: { value: handle, enumerable: true },
  });

  return {
    handler,
    ready: boot.then(() => undefined),
    async close() {
      // An in-flight boot finishes constructing the service after a bare close
      // would have returned; wait for it so the relay socket never leaks.
      await boot.catch(() => {});
      await ownedService?.close();
    },
  };
}

/**
 * True when adapter options are the flat all-in-one form (no prebuilt `host`).
 * The composed form always carries `host`; the flat form carries the order
 * hooks directly. Composed options that merely forgot `host` (e.g.
 * `{ service, authorize }`) throw the missing-host error instead of entering
 * the all-in-one path and blaming the caller for omitting nwc/db/onPaid.
 */
export function isOpenReceiveStackOptions<Order>(
  options: CreateOpenReceiveHttpHandlerOptions | CreateOpenReceiveStackOptions<Order>,
): options is CreateOpenReceiveStackOptions<Order> {
  if ((options as { host?: unknown }).host !== undefined) return false;
  const flat = options as CreateOpenReceiveStackOptions<Order>;
  if (
    flat.nwc !== undefined ||
    flat.db !== undefined ||
    flat.payments !== undefined ||
    flat.loadOrder !== undefined ||
    flat.amountForOrder !== undefined ||
    flat.onPaid !== undefined
  ) {
    return true;
  }
  throw new TypeError(
    "OpenReceive composed options require host: pass { service, host, authorize }, or use the all-in-one form with db/loadOrder/amountForOrder/onPaid.",
  );
}
