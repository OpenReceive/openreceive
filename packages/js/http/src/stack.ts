import { compact, redactSecrets } from "@openreceive/core";
import { ConfigError, createOpenReceive, type OpenReceive } from "@openreceive/node";
import { createRequestId, errorResponse, HttpError } from "./errors.ts";
import type { CreateHttpHandlerOptions, HttpHandler } from "./handler.ts";
import { createHttpHandler } from "./handler.ts";
import type {
  CreateHostDbOptions,
  CreateHostRepositoryOptions,
  CreateHostSupabaseOptions,
} from "./host-payments.ts";
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
 * with a custom repository (`payments`, advanced) it includes the resolved
 * reference and the repository transaction handle. With a Supabase project
 * reached over HTTPS (`supabase`) there is no `onPaid`: the host's SQL
 * function `public.openreceive_on_paid` fulfills inside the settlement
 * transaction. The branch carries the hook's type, so the wrong signature is
 * a type error rather than a runtime surprise.
 */
export type StackStorage<Transaction = unknown> =
  | Pick<CreateHostDbOptions, "db" | "tableName" | "onPaid" | "payments" | "supabase">
  | Pick<CreateHostSupabaseOptions, "supabase" | "onPaid" | "db" | "tableName" | "payments">
  | Pick<
      CreateHostRepositoryOptions<Transaction>,
      "payments" | "onPaid" | "db" | "tableName" | "supabase"
    >;

export interface CreateStackOptions<Transaction = unknown>
  extends Omit<CreateHttpHandlerOptions, "service" | "host">,
    Omit<CreateHostDbOptions, "db" | "tableName" | "onPaid" | "payments" | "supabase"> {
  readonly wallet: StackWallet;
  readonly storage: StackStorage<Transaction>;
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
   * construction. A failed boot answers 503 `WALLET_UNAVAILABLE`; with an
   * `nwc` wallet, the first request after a short wait (1 s, doubling to 60 s)
   * boots again and is served if the wallet answers.
   */
  readonly handler: HttpHandler;
  /**
   * Settles when the first boot has finished. It rejects only for what trying
   * again cannot fix: no NWC code, a malformed one, a wallet that can spend or
   * lacks the receive methods. A relay that did not answer resolves it, as a
   * shop should still start: checkouts answer 503 and the first request after
   * a short wait boots again. So it is safe to await before `listen()`, and
   * it does not prove the wallet answered; `openreceive doctor` does.
   */
  readonly ready: Promise<void>;
  /** Closes the service if the stack created it. */
  close(): Promise<void>;
}

export function createStack<Transaction = unknown>(
  options: CreateStackOptions<Transaction>,
): Stack {
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
  const boot = createRetryingBoot(
    async () => {
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
    },
    {
      // A service the host passed in is the host's promise, so its failure
      // stays as it is; a boot the stack owns (an `nwc` code) is retried.
      retries: wallet.service === undefined,
      // Fail loud at boot even if the host never awaits ready or sends a
      // request; the rejection still surfaces on ready and on every request.
      // The message only: a boot-time wallet error object carries its raw
      // cause, which has passed through none of the redaction the host wired
      // for every other line.
      onFailure(error, retryAfterMs) {
        const retry =
          retryAfterMs === undefined
            ? ""
            : ` The first request after ${retryAfterMs / 1000} s tries again.`;
        const message = `OpenReceive stack failed to start: ${redactSecrets(
          error instanceof Error ? error.message : String(error),
        )}${retry}`;
        if (onBootFailure === undefined) console.error(message);
        else onBootFailure(message);
      },
    },
  );

  const handle = async (request: Request, extras?: { native?: unknown }): Promise<Response> => {
    let booted: HttpHandler;
    try {
      booted = await boot.current();
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

  // `ready` is a promise of its own: a host that never awaits it must not get
  // an unhandled rejection when boot fails, which ends a Node process and a
  // Deno isolate. Requests already answer that failure with a 503. It reports
  // the first boot; requests keep retrying after it. A service the host passed
  // in is never retried, so its failure always rejects.
  const ready = boot.first.then(
    () => undefined,
    (error: unknown) => {
      if (wallet.service === undefined && error instanceof ConfigError && error.retryable) return;
      throw error;
    },
  );
  ready.catch(() => {});

  return {
    handler,
    ready,
    async close() {
      // An in-flight boot finishes constructing the service after a bare close
      // would have returned; wait for it so the relay socket never leaks.
      await boot.stop();
      await ownedService?.close();
    },
  };
}

/** Wait after a failed boot before a request may start the next attempt. */
export const BOOT_RETRY_FIRST_MS = 1_000;
/** The wait doubles after each failed attempt, up to this. */
export const BOOT_RETRY_MAX_MS = 60_000;

export interface RetryingBoot<T> {
  /** The first attempt, which `ready` reports. */
  readonly first: Promise<T>;
  /** The latest attempt, after starting a new one when a failed one has waited long enough. */
  current(): Promise<T>;
  /** No further attempts; resolves once the latest one has settled. */
  stop(): Promise<void>;
}

/**
 * A boot that a failure does not end. One slow relay handshake at start-up
 * must not take payments down until a restart. There is no timer: a call to
 * `current()` once the wait is over starts the next attempt, so the request
 * that made it is served by that attempt. The wait starts at
 * `BOOT_RETRY_FIRST_MS` and doubles after each failure up to
 * `BOOT_RETRY_MAX_MS`; a success resets it. Exported for tests.
 */
export function createRetryingBoot<T>(
  start: () => Promise<T>,
  options: {
    readonly retries: boolean;
    /** Called once per failed attempt; `retryAfterMs` is undefined when no retry follows. */
    readonly onFailure: (error: unknown, retryAfterMs: number | undefined) => void;
    readonly now?: () => number;
  },
): RetryingBoot<T> {
  const now = options.now ?? Date.now;
  let stopped = false;
  let failedAt: number | undefined;
  let retryAfterMs = BOOT_RETRY_FIRST_MS;
  const attempt = (): Promise<T> => {
    const promise = start();
    promise.then(
      () => {
        failedAt = undefined;
        retryAfterMs = BOOT_RETRY_FIRST_MS;
      },
      (error: unknown) => {
        failedAt = now();
        options.onFailure(error, options.retries ? retryAfterMs : undefined);
      },
    );
    return promise;
  };
  const first = attempt();
  let latest = first;
  return {
    first,
    current() {
      if (
        options.retries &&
        !stopped &&
        failedAt !== undefined &&
        now() - failedAt >= retryAfterMs
      ) {
        failedAt = undefined;
        retryAfterMs = Math.min(retryAfterMs * 2, BOOT_RETRY_MAX_MS);
        latest = attempt();
      }
      return latest;
    },
    async stop() {
      stopped = true;
      await latest.then(
        () => {},
        () => {},
      );
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
    "OpenReceive composed options require host: pass { service, host, authorize } (host built by " +
      "createHost), or use the all-in-one form with wallet/storage/amountFor. " +
      "https://openreceive.org/guides/api-reference.md#framework-adapters",
  );
}
