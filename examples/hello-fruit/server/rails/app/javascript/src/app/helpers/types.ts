// Shapes mirror app/controllers/shop_controller.rb#app_data and
// app/models/order.rb#summary. Keep in sync.

import type { HelloFruitDemoOrder } from "../../../../../../../shared/demo-order.ts";

export interface HelloFruitFiatAmount {
  readonly currency: string;
  readonly value: string;
}

export interface HelloFruitFruitPayload {
  readonly id: string;
  readonly name: string;
  /** Public path of the sticker image, e.g. "/stickers/banana.svg". */
  readonly sticker: string;
  readonly fiat: HelloFruitFiatAmount;
}

export interface HelloFruitProductInfo {
  readonly name: string;
  readonly description: string;
}

export interface ShopBootstrap {
  readonly fruits: readonly HelloFruitFruitPayload[];
  readonly product: HelloFruitProductInfo;
  readonly currencies: readonly string[];
  /** Present when the shell was requested at /checkout/:order_id. */
  readonly order: HelloFruitDemoOrder | null;
  /** Mount path of the OpenReceive engine, e.g. "/openreceive". */
  readonly openreceive_prefix: string;
}

export type { HelloFruitDemoOrder };
