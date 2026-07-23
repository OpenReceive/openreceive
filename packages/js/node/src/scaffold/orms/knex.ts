import { knexOrderIdColumn, nextStepsMarkdown } from "../shared.ts";
import { attemptConflictClass, hooksStubContents, recordMapperHelper } from "../snippets.ts";
import type { ScaffoldFile, ScaffoldPaymentsOptions } from "../types.ts";

export function renderKnexFiles(options: ScaffoldPaymentsOptions): ScaffoldFile[] {
  const fk = options.skipForeignKey
    ? ""
    : `\n      .references("id").inTable("${options.orderTable}").onDelete("RESTRICT")`;

  const migration = `/** @param {import("knex").Knex} knex */
export async function up(knex) {
  await knex.schema.createTable("openreceive_payments", (table) => {
    table.bigIncrements("id").primary();
    ${knexOrderIdColumn(options.orderIdType)}${fk};
    table.string("payment_hash", 64).notNullable().unique();
    table.timestamp("paid_at", { useTz: true }).nullable();
    table.timestamp("expires_at", { useTz: true }).notNullable();
    table.json("swap_data").nullable();
    table.timestamps(true, true);
    table.index(["order_id", "created_at"]);
    table.index(["paid_at", "created_at"]);
  });
}

/** @param {import("knex").Knex} knex */
export async function down(knex) {
  await knex.schema.dropTable("openreceive_payments");
}
`;

  const repository = `import {
  openReceivePaymentInsert,
  type OpenReceivePaymentRecord,
  type OpenReceivePaymentRepository,
} from "@openreceive/http";
import type { Knex } from "knex";
${attemptConflictClass()}
${recordMapperHelper()}
interface PaymentRow {
  order_id: string | number;
  payment_hash: string;
  paid_at: Date | null;
  expires_at: Date;
  created_at: Date;
  swap_data?: unknown | null;
}

function mapRow(row: PaymentRow): OpenReceivePaymentRecord {
  return toPaymentRecord({
    orderId: row.order_id,
    paymentHash: row.payment_hash,
    paidAt: row.paid_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    swapData: row.swap_data,
  });
}

export function createOpenReceivePaymentsRepository(knex: Knex): OpenReceivePaymentRepository {
  return {
    async listForOrder(orderId) {
      const rows = await knex<PaymentRow>("openreceive_payments")
        .where({ order_id: orderId })
        .orderBy([
          { column: "created_at", order: "desc" },
          { column: "payment_hash", order: "desc" },
        });
      return rows.map(mapRow);
    },

    async commitAttempt(input) {
      const values = openReceivePaymentInsert(input);
      await knex.transaction(async (trx) => {
        await trx("${options.orderTable}").where({ id: values.orderId }).forUpdate().first();

        const same = await trx<PaymentRow>("openreceive_payments")
          .where({ payment_hash: values.paymentHash })
          .first();
        if (same) {
          if (String(same.order_id) !== values.orderId) {
            throw new OpenReceiveAttemptConflict("payment hash belongs to another order");
          }
          return;
        }

        const blocking = await trx<PaymentRow>("openreceive_payments")
          .where({ order_id: values.orderId })
          .andWhere((builder) => {
            builder
              .whereNotNull("paid_at")
              .orWhere((live) => {
                live.whereNull("paid_at").andWhere("expires_at", ">", trx.fn.now());
              });
          })
          .first();
        if (blocking) {
          throw new OpenReceiveAttemptConflict(
            "Order already has a paid or live payment attempt.",
          );
        }

        await trx("openreceive_payments").insert({
          order_id: values.orderId,
          payment_hash: values.paymentHash,
          expires_at: new Date(values.expiresAt * 1000),
          swap_data: values.swapData ?? null,
        });
      });
    },
  };
}
`;

  const markPaid = `import type { Knex } from "knex";

export interface MarkPaidOnceResult {
  readonly firstForOrder: boolean;
  readonly paymentHash: string;
  readonly orderId: string;
}

export async function markOpenReceivePaidOnce(
  knex: Knex,
  input: { paymentHash: string; paidAt: number },
): Promise<MarkPaidOnceResult> {
  return knex.transaction(async (trx) => {
    const payment = await trx("openreceive_payments")
      .where({ payment_hash: input.paymentHash.toLowerCase() })
      .first();
    if (!payment) throw new Error("OpenReceive payment attempt not found.");

    await trx("${options.orderTable}").where({ id: payment.order_id }).forUpdate().first();

    const locked = await trx("openreceive_payments")
      .where({ payment_hash: payment.payment_hash })
      .first();
    if (locked.paid_at) {
      return {
        firstForOrder: false,
        paymentHash: locked.payment_hash,
        orderId: String(locked.order_id),
      };
    }

    const siblingPaid = await trx("openreceive_payments")
      .where({ order_id: locked.order_id })
      .whereNotNull("paid_at")
      .whereNot({ payment_hash: locked.payment_hash })
      .first();

    await trx("openreceive_payments")
      .where({ payment_hash: locked.payment_hash })
      .update({ paid_at: new Date(input.paidAt * 1000) });

    return {
      firstForOrder: siblingPaid === undefined,
      paymentHash: locked.payment_hash,
      orderId: String(locked.order_id),
    };
  });
}
`;

  return [
    {
      path: "db/migrations/20260101000000_create_openreceive_payments.js",
      contents: migration,
    },
    { path: "src/openreceive/payments-repository.ts", contents: repository },
    { path: "src/openreceive/mark-paid-once.ts", contents: markPaid },
    { path: "src/openreceive/hooks.stub.ts", contents: hooksStubContents() },
    { path: "OPENRECEIVE_PAYMENTS.md", contents: nextStepsMarkdown(options) },
  ];
}
