import { isSqlite, nextStepsMarkdown, typeOrmOrderIdColumn } from "../shared.ts";
import { attemptConflictClass, hostStubContents, recordMapperHelper } from "../snippets.ts";
import type { ScaffoldFile, ScaffoldPaymentsOptions } from "../types.ts";

export function renderTypeOrmFiles(options: ScaffoldPaymentsOptions): ScaffoldFile[] {
  const sqlite = isSqlite(options);
  const relation = options.skipForeignKey
    ? ""
    : `
  @ManyToOne(() => ${options.orderModel}, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "order_id" })
  order!: ${options.orderModel};
`;

  const orderImport = options.skipForeignKey
    ? ""
    : `import { ${options.orderModel} } from "../${kebab(options.orderModel)}.ts"; // TODO: point at your host order entity\n`;
  const relationImports = options.skipForeignKey ? "" : `\n  JoinColumn,\n  ManyToOne,`;

  const dateType = sqlite ? `"datetime"` : `"timestamptz"`;
  const jsonType = sqlite ? `"simple-json"` : `"jsonb"`;

  const entity = `${orderImport}import {
  Column,
  Entity,
  Index,${relationImports}
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

@Entity({ name: "openreceive_payments" })
@Index(["orderId", "createdAt"])
@Index(["paidAt", "createdAt"])
export class OpenReceivePayment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column(${typeOrmOrderIdColumn(options.orderIdType, options.dialect)})
  orderId!: string | number;
${relation}
  @Column({ name: "payment_hash", length: 64, unique: true })
  paymentHash!: string;

  @Column({ name: "paid_at", type: ${dateType}, nullable: true })
  paidAt!: Date | null;

  @Column({ name: "expires_at", type: ${dateType} })
  expiresAt!: Date;

  @Column({ name: "checkout_data", type: ${jsonType} })
  checkoutData!: unknown;

  @Column({ name: "swap_data", type: ${jsonType}, nullable: true, select: false })
  swapData!: unknown | null;

  @Column({ name: "created_at", type: ${dateType} })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: ${dateType} })
  updatedAt!: Date;
}
`;

  const lockCommit = sqlite
    ? `        // SQLite: single-writer transaction; pessimistic locks are unavailable.
        await manager
          .getRepository("${options.orderModel}")
          .createQueryBuilder("order")
          .where("order.id = :id", { id: values.orderId })
          .getOne();`
    : `        await manager
          .getRepository("${options.orderModel}")
          .createQueryBuilder("order")
          .setLock("pessimistic_write")
          .where("order.id = :id", { id: values.orderId })
          .getOne();`;

  const lockPaid = sqlite
    ? `    await manager
      .getRepository("${options.orderModel}")
      .createQueryBuilder("order")
      .where("order.id = :id", { id: payment.orderId })
      .getOne();`
    : `    await manager
      .getRepository("${options.orderModel}")
      .createQueryBuilder("order")
      .setLock("pessimistic_write")
      .where("order.id = :id", { id: payment.orderId })
      .getOne();`;

  const repository = `import {
  openReceivePaymentInsert,
  type OpenReceivePaymentRecord,
  type OpenReceiveHostRepository,
} from "@openreceive/http";
import { IsNull, type DataSource } from "typeorm";
import { OpenReceivePayment } from "../entities/open-receive-payment.ts";
${attemptConflictClass()}
${recordMapperHelper()}
export function createOpenReceivePaymentsRepository(
  dataSource: DataSource,
): OpenReceiveHostRepository {
  return {
    async listForOrder(orderId) {
      const rows = await dataSource.getRepository(OpenReceivePayment).find({
        where: { orderId: orderId as never },
        order: { createdAt: "DESC", paymentHash: "DESC" },
        select: {
          orderId: true,
          paymentHash: true,
          paidAt: true,
          expiresAt: true,
          createdAt: true,
          checkoutData: true,
          swapData: true,
        },
      });
      return rows.map(toPaymentRecord);
    },

    async commitAttempt(input) {
      const values = openReceivePaymentInsert(input);
      await dataSource.transaction(async (manager) => {
${lockCommit}

        const same = await manager.findOne(OpenReceivePayment, {
          where: { paymentHash: values.paymentHash },
        });
        if (same) {
          if (String(same.orderId) !== values.orderId) {
            throw new OpenReceiveAttemptConflict("payment hash belongs to another order");
          }
          return;
        }

        const paid = await manager
          .createQueryBuilder(OpenReceivePayment, "payment")
          .where("payment.order_id = :orderId", { orderId: values.orderId })
          .andWhere("payment.paid_at IS NOT NULL")
          .getOne();
        if (paid) {
          throw new OpenReceiveAttemptConflict("Order already has a paid payment attempt.");
        }

        const live = await manager
          .createQueryBuilder(OpenReceivePayment, "payment")
          .where("payment.order_id = :orderId", { orderId: values.orderId })
          .andWhere("payment.paid_at IS NULL")
          .andWhere("payment.expires_at > :now", { now: new Date() })
          .getOne();
        if (live) {
          throw new OpenReceiveAttemptConflict("Order already has a live payment attempt.");
        }

        await manager.save(
          manager.create(OpenReceivePayment, {
            orderId: values.orderId as never,
            paymentHash: values.paymentHash,
            expiresAt: new Date(values.expiresAt * 1000),
            createdAt: new Date(values.createdAt * 1000),
            checkoutData: values.checkout,
            swapData: values.swapData ?? null,
          }),
        );
      });
    },

    async listUnsettledAttempts() {
      const rows = await dataSource.getRepository(OpenReceivePayment).find({
        where: { paidAt: IsNull() },
        select: { paymentHash: true, createdAt: true },
      });
      return rows.map((row) => ({
        paymentHash: row.paymentHash,
        createdAt: Math.floor(row.createdAt.getTime() / 1000),
      }));
    },
  };
}
`;

  const markPaid = `import type { DataSource } from "typeorm";
import { OpenReceivePayment } from "../entities/open-receive-payment.ts";

export interface MarkPaidOnceResult {
  readonly firstForOrder: boolean;
  readonly paymentHash: string;
  readonly orderId: string;
}

export async function markOpenReceivePaidOnce(
  dataSource: DataSource,
  input: { paymentHash: string; paidAt: number },
  onFirstSettlement: (
    manager: unknown,
    settled: { orderId: string; paymentHash: string },
  ) => Promise<void>,
): Promise<MarkPaidOnceResult | null> {
  return dataSource.transaction(async (manager) => {
    const payment = await manager.findOne(OpenReceivePayment, {
      where: { paymentHash: input.paymentHash.toLowerCase() },
    });
    if (payment === null) return null;

${lockPaid}

    const locked = await manager.findOneOrFail(OpenReceivePayment, {
      where: { paymentHash: payment.paymentHash },
    });
    if (locked.paidAt) {
      return {
        firstForOrder: false,
        paymentHash: locked.paymentHash,
        orderId: String(locked.orderId),
      };
    }

    const siblingPaid = await manager
      .createQueryBuilder(OpenReceivePayment, "payment")
      .where("payment.order_id = :orderId", { orderId: locked.orderId })
      .andWhere("payment.paid_at IS NOT NULL")
      .andWhere("payment.payment_hash <> :hash", { hash: locked.paymentHash })
      .getOne();

    locked.paidAt = new Date(input.paidAt * 1000);
    await manager.save(locked);
    if (siblingPaid === null) {
      await onFirstSettlement(manager, {
        orderId: String(locked.orderId),
        paymentHash: locked.paymentHash,
      });
    }

    return {
      firstForOrder: siblingPaid === null,
      paymentHash: locked.paymentHash,
      orderId: String(locked.orderId),
    };
  });
}
`;

  return [
    { path: "src/entities/open-receive-payment.ts", contents: entity },
    { path: "src/openreceive/payments-repository.ts", contents: repository },
    { path: "src/openreceive/mark-paid-once.ts", contents: markPaid },
    { path: "src/openreceive/host.stub.ts", contents: hostStubContents() },
    { path: "OPENRECEIVE_PAYMENTS.md", contents: nextStepsMarkdown(options) },
  ];
}

function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}
