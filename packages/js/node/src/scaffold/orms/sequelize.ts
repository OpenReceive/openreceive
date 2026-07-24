import { isSqlite, nextStepsMarkdown, sequelizeOrderIdType } from "../shared.ts";
import { attemptConflictClass, hostStubContents, recordMapperHelper } from "../snippets.ts";
import type { ScaffoldFile, ScaffoldPaymentsOptions } from "../types.ts";

export function renderSequelizeFiles(options: ScaffoldPaymentsOptions): ScaffoldFile[] {
  const sqlite = isSqlite(options);

  const model = `import {
  DataTypes,
  type Model,
  type ModelStatic,
  type Optional,
  type Sequelize,
} from "sequelize";

export interface OpenReceivePaymentAttributes {
  id: number;
  orderId: string | number;
  paymentHash: string;
  paidAt: Date | null;
  expiresAt: Date;
  checkoutData: unknown;
  swapData: unknown | null;
  createdAt: Date;
  updatedAt: Date;
}

export type OpenReceivePaymentCreation = Optional<
  OpenReceivePaymentAttributes,
  "id" | "paidAt" | "swapData" | "updatedAt"
>;

export type OpenReceivePaymentModel = Model<
  OpenReceivePaymentAttributes,
  OpenReceivePaymentCreation
> &
  OpenReceivePaymentAttributes;

export function initOpenReceivePayment(
  sequelize: Sequelize,
): ModelStatic<OpenReceivePaymentModel> {
  const OpenReceivePayment = sequelize.define<OpenReceivePaymentModel>(
    "OpenReceivePayment",
    {
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      orderId: {
        type: ${sequelizeOrderIdType(options.orderIdType)},
        allowNull: false,
        field: "order_id",
      },
      paymentHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        unique: true,
        field: "payment_hash",
      },
      paidAt: { type: DataTypes.DATE, allowNull: true, field: "paid_at" },
      expiresAt: { type: DataTypes.DATE, allowNull: false, field: "expires_at" },
      checkoutData: { type: DataTypes.JSON, allowNull: false, field: "checkout_data" },
      swapData: { type: DataTypes.JSON, allowNull: true, field: "swap_data" },
      createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
    },
    {
      tableName: "openreceive_payments",
      underscored: true,
      defaultScope: { attributes: { exclude: ["swapData"] } },
      indexes: [
        { fields: ["order_id", "created_at"] },
        { fields: ["paid_at", "created_at"] },
      ],
    },
  );

${
  options.skipForeignKey
    ? "  // Foreign key skipped (--skip-foreign-key)."
    : `  // Optional: OpenReceivePayment.belongsTo(Order, { foreignKey: "orderId", targetKey: "id" });`
}

  return OpenReceivePayment;
}
`;

  const lockCommit = sqlite
    ? `        // SQLite: single-writer transaction; skip Postgres row locks.
        await sequelize.query(
          \`SELECT id FROM "${options.orderTable}" WHERE id = :id\`,
          { replacements: { id: values.orderId }, transaction },
        );`
    : `        await sequelize.query(
          \`SELECT id FROM "${options.orderTable}" WHERE id = :id FOR UPDATE\`,
          { replacements: { id: values.orderId }, transaction },
        );`;

  const lockPaid = sqlite
    ? `    await sequelize.query(
      \`SELECT id FROM "${options.orderTable}" WHERE id = :id\`,
      { replacements: { id: payment.orderId }, transaction },
    );`
    : `    await sequelize.query(
      \`SELECT id FROM "${options.orderTable}" WHERE id = :id FOR UPDATE\`,
      { replacements: { id: payment.orderId }, transaction },
    );`;

  const repository = `import {
  openReceivePaymentInsert,
  type OpenReceivePaymentRecord,
  type OpenReceiveHostRepository,
} from "@openreceive/http";
import { Op, type Sequelize } from "sequelize";
import {
  initOpenReceivePayment,
  type OpenReceivePaymentModel,
} from "../models/open-receive-payment.ts";
${attemptConflictClass()}
${recordMapperHelper()}
export function createOpenReceivePaymentsRepository(
  sequelize: Sequelize,
  OpenReceivePayment?: ReturnType<typeof initOpenReceivePayment>,
): OpenReceiveHostRepository {
  const Payment =
    OpenReceivePayment ??
    (sequelize.models.OpenReceivePayment as ReturnType<typeof initOpenReceivePayment> | undefined);
  if (!Payment) {
    throw new Error("Call initOpenReceivePayment(sequelize) during boot before creating the host integration.");
  }
  return {
    async listForOrder(orderId) {
      const rows = await Payment.unscoped().findAll({
        where: { orderId: orderId as never },
        order: [
          ["createdAt", "DESC"],
          ["paymentHash", "DESC"],
        ],
      });
      return rows.map((row) => toPaymentRecord(row.get({ plain: true })));
    },

    async commitAttempt(input) {
      const values = openReceivePaymentInsert(input);
      await sequelize.transaction(async (transaction) => {
${lockCommit}

        const same = await Payment.unscoped().findOne({
          where: { paymentHash: values.paymentHash },
          transaction,
        });
        if (same) {
          if (String(same.orderId) !== values.orderId) {
            throw new OpenReceiveAttemptConflict("payment hash belongs to another order");
          }
          return;
        }

        const blocking = await Payment.unscoped().findOne({
          where: {
            orderId: values.orderId as never,
            [Op.or]: [
              { paidAt: { [Op.ne]: null } },
              { paidAt: null, expiresAt: { [Op.gt]: new Date() } },
            ],
          },
          transaction,
        });
        if (blocking) {
          throw new OpenReceiveAttemptConflict(
            "Order already has a paid or live payment attempt.",
          );
        }

        await Payment.create(
          {
            orderId: values.orderId as never,
            paymentHash: values.paymentHash,
            expiresAt: new Date(values.expiresAt * 1000),
            createdAt: new Date(values.createdAt * 1000),
            checkoutData: values.checkout,
            swapData: values.swapData ?? null,
          },
          { transaction },
        );
      });
    },

    async listUnsettledAttempts() {
      const rows = await Payment.unscoped().findAll({
        where: { paidAt: null },
        attributes: ["paymentHash", "createdAt"],
      });
      return rows.map((row) => ({
        paymentHash: row.paymentHash,
        createdAt: Math.floor(row.createdAt.getTime() / 1000),
      }));
    },
  };
}

export type { OpenReceivePaymentModel };
`;

  const markPaid = `import { Op, type Sequelize } from "sequelize";
import { initOpenReceivePayment } from "../models/open-receive-payment.ts";

export interface MarkPaidOnceResult {
  readonly firstForOrder: boolean;
  readonly paymentHash: string;
  readonly orderId: string;
}

export async function markOpenReceivePaidOnce(
  sequelize: Sequelize,
  input: { paymentHash: string; paidAt: number },
  onFirstSettlement: (
    transaction: unknown,
    settled: { orderId: string; paymentHash: string },
  ) => Promise<void>,
  OpenReceivePayment?: ReturnType<typeof initOpenReceivePayment>,
): Promise<MarkPaidOnceResult | null> {
  const Payment =
    OpenReceivePayment ??
    (sequelize.models.OpenReceivePayment as ReturnType<typeof initOpenReceivePayment> | undefined);
  if (!Payment) {
    throw new Error("Call initOpenReceivePayment(sequelize) during boot before markOpenReceivePaidOnce.");
  }

  return sequelize.transaction(async (transaction) => {
    const payment = await Payment.unscoped().findOne({
      where: { paymentHash: input.paymentHash.toLowerCase() },
      transaction,
    });
    if (payment === null) return null;

${lockPaid}

    await payment.reload({ transaction });
    if (payment.paidAt) {
      return {
        firstForOrder: false,
        paymentHash: payment.paymentHash,
        orderId: String(payment.orderId),
      };
    }

    const siblingPaid = await Payment.unscoped().findOne({
      where: {
        orderId: payment.orderId,
        paidAt: { [Op.ne]: null },
        paymentHash: { [Op.ne]: payment.paymentHash },
      },
      transaction,
    });

    await payment.update(
      { paidAt: new Date(input.paidAt * 1000) },
      { transaction },
    );
    if (siblingPaid === null) {
      await onFirstSettlement(transaction, {
        orderId: String(payment.orderId),
        paymentHash: payment.paymentHash,
      });
    }

    return {
      firstForOrder: siblingPaid === null,
      paymentHash: payment.paymentHash,
      orderId: String(payment.orderId),
    };
  });
}
`;

  return [
    { path: "src/models/open-receive-payment.ts", contents: model },
    { path: "src/openreceive/payments-repository.ts", contents: repository },
    { path: "src/openreceive/mark-paid-once.ts", contents: markPaid },
    { path: "src/openreceive/host.stub.ts", contents: hostStubContents() },
    { path: "OPENRECEIVE_PAYMENTS.md", contents: nextStepsMarkdown(options) },
  ];
}
