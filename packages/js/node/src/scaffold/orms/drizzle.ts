import { drizzleOrderIdColumn, nextStepsMarkdown } from "../shared.ts";
import { attemptConflictClass, hooksStubContents, recordMapperHelper } from "../snippets.ts";
import type { ScaffoldFile, ScaffoldPaymentsOptions } from "../types.ts";

export function renderDrizzleFiles(options: ScaffoldPaymentsOptions): ScaffoldFile[] {
  const ordersImportNote = options.skipForeignKey
    ? ""
    : `// TODO: import your host orders table and rename \`${camel(options.orderTable)}\` if needed.\n`;

  const orderIdLine = options.skipForeignKey
    ? `orderId: ${drizzleOrderIdColumn(options.orderIdType)},`
    : `orderId: ${drizzleOrderIdColumn(options.orderIdType)}.references(() => ${camel(options.orderTable)}.id, { onDelete: "restrict" }),`;

  const schema = `import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
${ordersImportNote}
export const openReceivePayments = pgTable(
  "openreceive_payments",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    ${orderIdLine}
    paymentHash: varchar("payment_hash", { length: 64 }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    swapData: jsonb("swap_data"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("openreceive_payments_hash_uidx").on(table.paymentHash),
    index("openreceive_payments_order_created_idx").on(table.orderId, table.createdAt),
    index("openreceive_payments_paid_created_idx").on(table.paidAt, table.createdAt),
  ],
);
`;

  const repository = `import {
  openReceivePaymentInsert,
  type OpenReceivePaymentRecord,
  type OpenReceivePaymentRepository,
} from "@openreceive/http";
import { and, desc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { openReceivePayments } from "../db/openreceive-payments.ts";
${attemptConflictClass()}
${recordMapperHelper()}
type Db = NodePgDatabase<Record<string, never>>;

export function createOpenReceivePaymentsRepository(db: Db): OpenReceivePaymentRepository {
  return {
    async listForOrder(orderId) {
      const rows = await db
        .select()
        .from(openReceivePayments)
        .where(eq(openReceivePayments.orderId, orderId as never))
        .orderBy(desc(openReceivePayments.createdAt), desc(openReceivePayments.paymentHash));
      return rows.map(toPaymentRecord);
    },

    async commitAttempt(input) {
      const values = openReceivePaymentInsert(input);
      await db.transaction(async (tx) => {
        await tx.execute(
          sql\`select id from \${sql.raw('"${options.orderTable}"')} where id = \${values.orderId} for update\`,
        );

        const sameRows = await tx
          .select()
          .from(openReceivePayments)
          .where(eq(openReceivePayments.paymentHash, values.paymentHash))
          .limit(1);
        const same = sameRows[0];
        if (same) {
          if (String(same.orderId) !== values.orderId) {
            throw new OpenReceiveAttemptConflict("payment hash belongs to another order");
          }
          return;
        }

        const blocking = await tx
          .select()
          .from(openReceivePayments)
          .where(
            and(
              eq(openReceivePayments.orderId, values.orderId as never),
              or(
                isNotNull(openReceivePayments.paidAt),
                and(
                  isNull(openReceivePayments.paidAt),
                  gt(openReceivePayments.expiresAt, new Date()),
                ),
              ),
            ),
          )
          .limit(1);
        if (blocking.length > 0) {
          throw new OpenReceiveAttemptConflict(
            "Order already has a paid or live payment attempt.",
          );
        }

        await tx.insert(openReceivePayments).values({
          orderId: values.orderId as never,
          paymentHash: values.paymentHash,
          expiresAt: new Date(values.expiresAt * 1000),
          swapData: values.swapData ?? null,
        });
      });
    },
  };
}
`;

  const markPaid = `import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { openReceivePayments } from "../db/openreceive-payments.ts";

type Db = NodePgDatabase<Record<string, never>>;

export interface MarkPaidOnceResult {
  readonly firstForOrder: boolean;
  readonly paymentHash: string;
  readonly orderId: string;
}

export async function markOpenReceivePaidOnce(
  db: Db,
  input: { paymentHash: string; paidAt: number },
): Promise<MarkPaidOnceResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(openReceivePayments)
      .where(eq(openReceivePayments.paymentHash, input.paymentHash.toLowerCase()))
      .limit(1);
    const payment = rows[0];
    if (!payment) throw new Error("OpenReceive payment attempt not found.");

    await tx.execute(
      sql\`select id from \${sql.raw('"${options.orderTable}"')} where id = \${payment.orderId} for update\`,
    );

    const lockedRows = await tx
      .select()
      .from(openReceivePayments)
      .where(eq(openReceivePayments.paymentHash, payment.paymentHash))
      .limit(1);
    const locked = lockedRows[0]!;
    if (locked.paidAt) {
      return {
        firstForOrder: false,
        paymentHash: locked.paymentHash,
        orderId: String(locked.orderId),
      };
    }

    const siblings = await tx
      .select()
      .from(openReceivePayments)
      .where(
        and(
          eq(openReceivePayments.orderId, locked.orderId),
          isNotNull(openReceivePayments.paidAt),
          ne(openReceivePayments.paymentHash, locked.paymentHash),
        ),
      )
      .limit(1);

    await tx
      .update(openReceivePayments)
      .set({ paidAt: new Date(input.paidAt * 1000) })
      .where(eq(openReceivePayments.paymentHash, locked.paymentHash));

    return {
      firstForOrder: siblings.length === 0,
      paymentHash: locked.paymentHash,
      orderId: String(locked.orderId),
    };
  });
}
`;

  return [
    { path: "src/db/openreceive-payments.ts", contents: schema },
    { path: "src/openreceive/payments-repository.ts", contents: repository },
    { path: "src/openreceive/mark-paid-once.ts", contents: markPaid },
    { path: "src/openreceive/hooks.stub.ts", contents: hooksStubContents() },
    { path: "OPENRECEIVE_PAYMENTS.md", contents: nextStepsMarkdown(options) },
  ];
}

function camel(table: string): string {
  return table.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
