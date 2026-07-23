import { isSqlite, nextStepsMarkdown, prismaOrderIdField } from "../shared.ts";
import { attemptConflictClass, hooksStubContents, recordMapperHelper } from "../snippets.ts";
import type { ScaffoldFile, ScaffoldPaymentsOptions } from "../types.ts";

export function renderPrismaFiles(options: ScaffoldPaymentsOptions): ScaffoldFile[] {
  const relation = options.skipForeignKey
    ? ""
    : `  order       ${options.orderModel} @relation(fields: [orderId], references: [id], onDelete: Restrict)\n`;

  const schema = `// Merge this model into your Prisma schema, then run:
//   npx prisma migrate dev --name create_openreceive_payments
//
// Dialect: ${options.dialect}
// Do not alter the host ${options.orderModel} / ${options.orderTable} table.
// orderId is indexed but not unique: one order may have many attempts.

model OpenReceivePayment {
  id          String    @id @default(cuid())
  orderId     ${prismaOrderIdField(options.orderIdType, options.dialect)}
${relation}  paymentHash String    @unique @db.VarChar(64) @map("payment_hash")
  paidAt      DateTime? @map("paid_at")
  expiresAt   DateTime  @map("expires_at")
  swapData    Json?     @map("swap_data")
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")

  @@index([orderId, createdAt])
  @@index([paidAt, createdAt])
  @@map("openreceive_payments")
}
`;

  const lockOrder = isSqlite(options)
    ? `        // SQLite serializes writers; a Prisma interactive transaction is enough.
        await tx.$queryRawUnsafe(
          \`SELECT id FROM "${options.orderTable}" WHERE id = ?\`,
          values.orderId,
        );`
    : `        await tx.$queryRawUnsafe(
          \`SELECT id FROM "${options.orderTable}" WHERE id = $1 FOR UPDATE\`,
          values.orderId,
        );`;

  const lockPaid = isSqlite(options)
    ? `    await tx.$queryRawUnsafe(
      \`SELECT id FROM "${options.orderTable}" WHERE id = ?\`,
      payment.orderId,
    );`
    : `    await tx.$queryRawUnsafe(
      \`SELECT id FROM "${options.orderTable}" WHERE id = $1 FOR UPDATE\`,
      payment.orderId,
    );`;

  const repository = `import {
  openReceivePaymentInsert,
  type OpenReceivePaymentRecord,
  type OpenReceivePaymentRepository,
} from "@openreceive/http";
import type { PrismaClient } from "@prisma/client";
${attemptConflictClass()}
${recordMapperHelper()}
/**
 * Host-owned OpenReceive payment repository for Prisma (${options.dialect}).
 * commitAttempt locks ${options.orderTable} before inserting a new attempt.
 */
export function createOpenReceivePaymentsRepository(
  prisma: PrismaClient,
): OpenReceivePaymentRepository {
  return {
    async listForOrder(orderId) {
      const rows = await prisma.openReceivePayment.findMany({
        where: { orderId: orderId as never },
        orderBy: [{ createdAt: "desc" }, { paymentHash: "desc" }],
      });
      return rows.map(toPaymentRecord);
    },

    async commitAttempt(input) {
      const values = openReceivePaymentInsert(input);
      await prisma.$transaction(async (tx) => {
${lockOrder}

        const same = await tx.openReceivePayment.findUnique({
          where: { paymentHash: values.paymentHash },
        });
        if (same) {
          if (String(same.orderId) !== values.orderId) {
            throw new OpenReceiveAttemptConflict("payment hash belongs to another order");
          }
          return;
        }

        const existing = await tx.openReceivePayment.findFirst({
          where: {
            orderId: values.orderId as never,
            OR: [
              { paidAt: { not: null } },
              { paidAt: null, expiresAt: { gt: new Date() } },
            ],
          },
        });
        if (existing) {
          throw new OpenReceiveAttemptConflict(
            "Order already has a paid or live payment attempt.",
          );
        }

        await tx.openReceivePayment.create({
          data: {
            orderId: values.orderId as never,
            paymentHash: values.paymentHash,
            expiresAt: new Date(values.expiresAt * 1000),
            swapData: values.swapData ?? undefined,
          },
        });
      });
    },
  };
}
`;

  const markPaid = `import type { PrismaClient } from "@prisma/client";

export interface MarkPaidOnceResult {
  readonly firstForOrder: boolean;
  readonly paymentHash: string;
  readonly orderId: string;
}

/**
 * Set paid_at once for the attempt. Fulfill the host order only when
 * firstForOrder is true. Safe under watcher replay.
 */
export async function markOpenReceivePaidOnce(
  prisma: PrismaClient,
  input: { paymentHash: string; paidAt: number },
): Promise<MarkPaidOnceResult> {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.openReceivePayment.findUniqueOrThrow({
      where: { paymentHash: input.paymentHash.toLowerCase() },
    });

${lockPaid}

    const locked = await tx.openReceivePayment.findUniqueOrThrow({
      where: { paymentHash: payment.paymentHash },
    });
    if (locked.paidAt) {
      return {
        firstForOrder: false,
        paymentHash: locked.paymentHash,
        orderId: String(locked.orderId),
      };
    }

    const siblingPaid = await tx.openReceivePayment.findFirst({
      where: {
        orderId: locked.orderId,
        paidAt: { not: null },
        NOT: { paymentHash: locked.paymentHash },
      },
    });

    await tx.openReceivePayment.update({
      where: { paymentHash: locked.paymentHash },
      data: { paidAt: new Date(input.paidAt * 1000) },
    });

    return {
      firstForOrder: siblingPaid === null,
      paymentHash: locked.paymentHash,
      orderId: String(locked.orderId),
    };
  });
}
`;

  return [
    { path: "prisma/schema.openreceive.prisma", contents: schema },
    { path: "src/openreceive/payments-repository.ts", contents: repository },
    { path: "src/openreceive/mark-paid-once.ts", contents: markPaid },
    { path: "src/openreceive/hooks.stub.ts", contents: hooksStubContents() },
    { path: "OPENRECEIVE_PAYMENTS.md", contents: nextStepsMarkdown(options) },
  ];
}
