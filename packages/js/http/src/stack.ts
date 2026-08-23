import { compact } from "@openreceive/core";
import { createOpenReceive, type OpenReceive } from "@openreceive/node";
import type { CreateOpenReceiveHttpHandlerOptions, OpenReceiveHttpHandler } from "./handler.ts";
import { createOpenReceiveHttpHandler } from "./handler.ts";
import type {
  CreateOpenReceiveHostDbOptions,
  CreateOpenReceiveHostRepositoryOptions,
} from "./host-payments.ts";
import { createOpenReceiveHost } from "./host-payments.ts";
import { normalizePrefix } from "./router.ts";

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
/**
 * The wallet the stack talks to: a receive-only NWC connection string — the
 * stack builds and owns the client, and `close()` closes it — or a prebuilt
 * (or promised) service for custom options, whose lifecycle stays yours.
 */
export type OpenReceiveStackWallet =
  | { readonly nwc: string; readonly service?: never }
  | { readonly service: OpenReceive | Promise<OpenReceive>; readonly nwc?: never };

/**
 * Where attempts live, which decides what `onPaid` receives. With the host
 * database handle (`db`, the default mode) it is the per-order
 * `OpenReceiveOrderSettlement`, with `orderId` and the transactional `query`;
 * with a custom repository (`payments`, advanced) it is the raw
 * `OpenReceiveSettlementEvent`. The branch carries the hook's type, so the
 * wrong signature is a type error rather than a runtime surprise.
 */
export type OpenReceiveStackStorage =
  | Pick<CreateOpenReceiveHostDbOptions<unknown>, "db" | "tableName" | "onPaid" | "payments">
  | Pick<
      CreateOpenReceiveHostRepositoryOptions<unknown>,
      "payments" | "onPaid" | "db" | "tableName"
    >;

export interface CreateOpenReceiveStackOptions<Order = unknown>
  extends Omit<CreateOpenReceiveHttpHandlerOptions, "service" | "host">,
    Omit<CreateOpenReceiveHostDbOptions<Order>, "db" | "tableName" | "onPaid" | "payments"> {
  readonly wallet: OpenReceiveStackWallet;
  readonly storage: OpenReceiveStackStorage;
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
  const { wallet, storage, loadOrder, amountForOrder, clock, ...handlerOptions } = options;
  // The storage branch reaches the host factory as the mode it is — a
  // repository stays repository mode, a database handle stays db mode — and
  // its `onPaid` already has the type of that branch.
  const host = createOpenReceiveHost<Order>({
    ...storage,
    loadOrder,
    amountForOrder,
    ...compact({ clock }),
  });
  const prefix = normalizePrefix(options.prefix ?? "/openreceive");

  let ownedService: OpenReceive | undefined;
  const boot: Promise<OpenReceiveHttpHandler> = (async () => {
    const resolved =
      wallet.service !== undefined
        ? await wallet.service
        : await createOpenReceive({ nwc: wallet.nwc });
    if (wallet.service === undefined) ownedService = resolved;
    return createOpenReceiveHttpHandler({
      ...handlerOptions,
      ...compact({ clock }),
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
    flat.wallet !== undefined ||
    flat.storage !== undefined ||
    flat.loadOrder !== undefined ||
    flat.amountForOrder !== undefined
  ) {
    return true;
  }
  throw new TypeError(
    "OpenReceive composed options require host: pass { service, host, authorize }, or use the all-in-one form with wallet/storage/loadOrder/amountForOrder.",
  );
}
