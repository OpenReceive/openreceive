import { compact } from "@openreceive/core";
import { createOpenReceive, type OpenReceive } from "@openreceive/node";
import { createRequestId, errorResponse, HttpError } from "./errors.ts";
import type { CreateHttpHandlerOptions, HttpHandler } from "./handler.ts";
import { createHttpHandler } from "./handler.ts";
import type { CreateHostDbOptions, CreateHostRepositoryOptions } from "./host-payments.ts";
import { createHost } from "./host-payments.ts";
import { normalizePrefix } from "./router.ts";

/**
 * The one-factory happy path (T1): three callbacks plus a db handle. The stack
 * builds the service, host, and handler in one call — the composed
 * `{ service, host, ... }` form and every individual piece stay exported for
 * tests and custom repositories.
 *
 * The stack starts NO background process: settlement of abandoned checkouts
 * happens opportunistically when any later OpenReceive call wins the durable
 * reconcile gate (the handler's default `opportunisticReconcile`). Hosts that
 * want push notifications or a poll loop run the optional worker —
 * `startNotificationWorker` — in a separate process.
 */
/**
 * The wallet the stack talks to: a receive-only NWC connection string — the
 * stack builds and owns the client, and `close()` closes it — or a prebuilt
 * (or promised) service for custom options, whose lifecycle stays yours.
 */
export type StackWallet =
  | { readonly nwc: string; readonly service?: never }
  | { readonly service: OpenReceive | Promise<OpenReceive>; readonly nwc?: never };

/**
 * Where attempts live, which decides what `onPaid` receives. With the host
 * database handle (`db`, the default mode) it is the per-reference
 * `PaymentSettlement`, with `reference` and the transactional `query`;
 * with a custom repository (`payments`, advanced) it is the raw
 * `SettlementEvent`. The branch carries the hook's type, so the
 * wrong signature is a type error rather than a runtime surprise.
 */
export type StackStorage =
  | Pick<CreateHostDbOptions, "db" | "tableName" | "onPaid" | "payments">
  | Pick<CreateHostRepositoryOptions, "payments" | "onPaid" | "db" | "tableName">;

export interface CreateStackOptions
  extends Omit<CreateHttpHandlerOptions, "service" | "host">,
    Omit<CreateHostDbOptions, "db" | "tableName" | "onPaid" | "payments"> {
  readonly wallet: StackWallet;
  readonly storage: StackStorage;
  /**
   * Where the one boot-failure line goes. Boot happens before any service
   * exists, so this is the only sink @openreceive/http can offer; it defaults
   * to `console.error`. The message only ever carries `error.message` — a
   * boot-time wallet error object carries a raw cause that has passed through
   * none of the redaction the service wires for every other line.
   */
  readonly onBootFailure?: (message: string) => void;
}

export interface Stack {
  /**
   * Handler that boots lazily: the first request (and `ready`) awaits service
   * construction. Boot failures surface on `ready` and on every request.
   */
  readonly handler: HttpHandler;
  /** Resolves when the service and handler are up. */
  readonly ready: Promise<void>;
  /** Closes the service if the stack created it. */
  close(): Promise<void>;
}

export function createStack(options: CreateStackOptions): Stack {
  const { wallet, storage, amountFor, clock, onBootFailure, ...handlerOptions } = options;
  // The storage branch reaches the host factory as the mode it is — a
  // repository stays repository mode, a database handle stays db mode — and
  // its `onPaid` already has the type of that branch.
  const host = createHost({
    ...storage,
    amountFor,
    ...compact({ clock }),
  });
  const prefix = normalizePrefix(options.prefix ?? "/openreceive");

  let ownedService: OpenReceive | undefined;
  const boot: Promise<HttpHandler> = (async () => {
    const resolved =
      wallet.service !== undefined
        ? await wallet.service
        : await createOpenReceive({ nwc: wallet.nwc });
    if (wallet.service === undefined) ownedService = resolved;
    return createHttpHandler({
      ...handlerOptions,
      ...compact({ clock }),
      service: resolved,
      host,
    });
  })();
  // Fail loud at boot even if the host never awaits ready or sends a request;
  // the rejection still surfaces on ready and on every request. The message
  // only: a boot-time wallet error object carries its raw cause, which has
  // passed through none of the redaction the host wired for every other line.
  boot.catch((error: unknown) => {
    const message = `OpenReceive stack failed to start: ${
      error instanceof Error ? error.message : String(error)
    }`;
    if (onBootFailure === undefined) console.error(message);
    else onBootFailure(message);
  });

  const handle = async (request: Request, extras?: { native?: unknown }): Promise<Response> => {
    let booted: HttpHandler;
    try {
      booted = await boot;
    } catch {
      // A boot failure is the wallet being unavailable, not this request being
      // wrong. Rethrowing hands express/fastify a raw error whose text bypasses
      // every redaction rule and shows the payer the host's generic error page
      // instead of the OpenReceive JSON error contract. The cause already
      // reached the one sanitized console line above.
      return errorResponse(
        new HttpError(
          503,
          "WALLET_UNAVAILABLE",
          "The payment service is not available. Please try again shortly.",
          { retryable: true },
        ),
        createRequestId(),
      );
    }
    return booted(request, extras);
  };
  const handler = handle as HttpHandler;
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
 * The composed form always carries `host`; the flat form carries the host
 * hooks directly. Composed options that merely forgot `host` (e.g.
 * `{ service, authorize }`) throw the missing-host error instead of entering
 * the all-in-one path and blaming the caller for omitting nwc/db/onPaid.
 */
export function isStackOptions(
  options: CreateHttpHandlerOptions | CreateStackOptions,
): options is CreateStackOptions {
  if ((options as { host?: unknown }).host !== undefined) return false;
  const flat = options as CreateStackOptions;
  if (flat.wallet !== undefined || flat.storage !== undefined || flat.amountFor !== undefined) {
    return true;
  }
  throw new TypeError(
    "OpenReceive composed options require host: pass { service, host, authorize }, or use the all-in-one form with wallet/storage/amountFor.",
  );
}
