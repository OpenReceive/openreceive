// @openreceive/vendure/plugin: the Vendure plugin. Add OpenReceivePlugin to
// vendure-config's plugins; it registers the payment method handler, the
// checkout's routes, a scheduled task and the migration for its two tables.
//
// Decorators are applied as plain calls (what TypeScript's legacy decorators
// compile to), so this package builds without experimentalDecorators.

import type { Readable } from "node:stream";
import { All, Controller, Req, Res } from "@nestjs/common";
import {
  Allow,
  Ctx,
  Logger,
  PaymentMethodHandler,
  Permission,
  PluginCommonModule,
  type RequestContext,
  type RuntimeVendureConfig,
  ScheduledTask,
  VendurePlugin,
} from "@vendure/core";
import { OPENRECEIVE_VENDURE_HANDLER_CODE, OPENRECEIVE_VENDURE_ROUTE_PREFIX } from "./index.ts";
import {
  checkTables,
  paymentTableStatements,
  type RouteRequest,
  type RouteResponse,
  reconcileAndPlaceOrders,
  serveRoute,
  settledPayment,
  useInjector,
} from "./runtime.ts";

export {
  OPENRECEIVE_VENDURE_HANDLER_CODE,
  OPENRECEIVE_VENDURE_ORDER_ROUTE,
  OPENRECEIVE_VENDURE_ROUTE_PREFIX,
} from "./index.ts";

type AnyDecorator = (
  target: object,
  key?: string | symbol,
  descriptorOrIndex?: PropertyDescriptor | number,
) => unknown;

/** A class decorator, or a method's decorators, applied last to first, as TypeScript does. */
function decorate(
  decorators: readonly unknown[],
  target: object,
  key?: string,
): PropertyDescriptor | object {
  let result: PropertyDescriptor | object =
    key === undefined
      ? target
      : (Object.getOwnPropertyDescriptor(target, key) as PropertyDescriptor);
  for (const decorator of [...decorators].reverse() as AnyDecorator[]) {
    const next =
      key === undefined
        ? (decorator as (target: object) => unknown)(result)
        : decorator(target, key, result as PropertyDescriptor);
    if (next !== undefined) result = next as PropertyDescriptor | object;
  }
  if (key !== undefined) Object.defineProperty(target, key, result as PropertyDescriptor);
  return result;
}

/** A parameter decorator, as a method decorator for parameter `index`. */
function param(index: number, decorator: ParameterDecorator): AnyDecorator {
  return (target, key) => {
    decorator(target, key, index);
  };
}

/**
 * Bitcoin Lightning, and swaps through a provider, into the merchant's own
 * wallet. The buyer pays on the storefront before the order is placed; the
 * plugin adds the settled payment to the order itself, so this handler
 * creates a payment only for the plugin's own calls, never from the Shop API.
 */
export const openReceivePaymentHandler = new PaymentMethodHandler({
  code: OPENRECEIVE_VENDURE_HANDLER_CODE,
  description: [
    {
      languageCode: "en",
      value: "OpenReceive: Bitcoin over Lightning into your own wallet, with optional swaps",
    },
  ],
  args: {},
  init: (injector) => {
    useInjector(injector);
    void checkTables();
  },
  createPayment: (ctx, order, _amount, _args, metadata) => settledPayment(ctx, order, metadata),
  // The payment was settled when it was added; there is nothing left to take.
  settlePayment: () => ({ success: true }),
  // An unpaid Lightning invoice simply expires.
  cancelPayment: () => ({ success: true }),
  /**
   * The wallet code is receive-only, so no refund leaves through OpenReceive.
   * The refund stays pending in Vendure until the merchant sends it from
   * their own wallet and settles it in the dashboard.
   */
  createRefund: async (_ctx, _input, amount, order, payment) => {
    Logger.warn(
      `OpenReceive recorded a refund of ${amount} (in ${order.currencyCode} minor units) for order ${order.code}, payment ${payment.transactionId}. The wallet code is receive-only: send it from your own wallet, then settle the refund in the dashboard.`,
      "OpenReceive",
    );
    return { state: "Pending", metadata: { paymentHash: payment.transactionId } };
  },
});

/**
 * Every minute, on the worker: finds a payment whose buyer closed the page
 * before it settled, and adds every paid payment that has no Vendure payment
 * yet to its order. Does nothing until NWC_URI is set.
 */
export const openReceiveReconcileTask = new ScheduledTask({
  id: "openreceive-reconcile",
  description: "OpenReceive: find payments whose buyer left, and place their orders",
  schedule: "* * * * *",
  execute: async ({ injector }) => {
    useInjector(injector);
    await reconcileAndPlaceOrders();
    return { result: "OpenReceive reconcile pass done" };
  },
});

interface QueryRunner {
  readonly connection: { readonly options: { readonly type: string } };
  query(sql: string): Promise<unknown>;
}

/**
 * Creates openreceive_payments and openreceive_meta when Vendure runs its
 * migrations. Removing the plugin keeps them: they are a record of payments
 * received, so `down` leaves them in place.
 */
export class OpenReceivePaymentTables1760918400000 {
  readonly name = "OpenReceivePaymentTables1760918400000";

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const statement of paymentTableStatements(queryRunner.connection.options.type)) {
      await queryRunner.query(statement);
    }
  }

  async down(): Promise<void> {}
}

/** The checkout's routes, under /openreceive on the Vendure server. */
class OpenReceiveController {
  async one(ctx: RequestContext, req: RouteRequest & Readable, res: RouteResponse): Promise<void> {
    await serveRoute(ctx, req, res);
  }

  async two(ctx: RequestContext, req: RouteRequest & Readable, res: RouteResponse): Promise<void> {
    await serveRoute(ctx, req, res);
  }
}

// /openreceive/order, /checkouts and /rates, then /checkouts/prepare,
// /payments/check and the swap routes. Vendure's guard reads the buyer's
// session from its cookie or bearer token before either runs.
for (const [method, path] of [
  ["one", ":segment"],
  ["two", ":segment/:action"],
] as const) {
  decorate(
    [All(path), Allow(Permission.Public), param(0, Ctx()), param(1, Req()), param(2, Res())],
    OpenReceiveController.prototype,
    method,
  );
}
decorate([Controller(OPENRECEIVE_VENDURE_ROUTE_PREFIX.slice(1))], OpenReceiveController);

/**
 * OpenReceive for Vendure. Codes come from the server's environment:
 * NWC_URI, and LSC_URI_PRIMARY for swaps.
 */
export class OpenReceivePlugin {}

decorate(
  [
    VendurePlugin({
      imports: [PluginCommonModule],
      controllers: [OpenReceiveController],
      compatibility: "^3.3.0",
      configuration: (config: RuntimeVendureConfig) => {
        config.paymentOptions.paymentMethodHandlers.push(openReceivePaymentHandler);
        config.schedulerOptions.tasks = [
          ...(config.schedulerOptions.tasks ?? []),
          openReceiveReconcileTask,
        ];
        const migrations = config.dbConnectionOptions.migrations;
        config.dbConnectionOptions.migrations = [
          ...(Array.isArray(migrations)
            ? migrations
            : migrations === undefined
              ? []
              : Object.values(migrations as object)),
          OpenReceivePaymentTables1760918400000,
        ];
        return config;
      },
    }),
  ],
  OpenReceivePlugin,
);
