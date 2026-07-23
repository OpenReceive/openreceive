import { nextStepsMarkdown, sequelizeOrderIdType } from "../shared.ts";
import { attemptConflictClass, hooksStubContents, recordMapperHelper } from "../snippets.ts";
import type { ScaffoldFile, ScaffoldPaymentsOptions } from "../types.ts";

export function renderSequelizeFiles(options: ScaffoldPaymentsOptions): ScaffoldFile[] {
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
  swapData: unknown | null;
  createdAt: Date;
  updatedAt: Date;
}

export type OpenReceivePaymentCreation = Optional<
  OpenReceivePaymentAttributes,
  "id" | "paidAt" | "swapData" | "createdAt" | "updatedAt"
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
      swapData: { type: DataTypes.JSON, allowNull: true, field: "swap_data" },
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

  const repository = `import {
  openReceivePaymentInsert,
  type OpenReceivePaymentRecord,
  type OpenReceivePaymentRepository,
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
): OpenReceivePaymentRepository {
  const Payment =
    OpenReceivePayment ??
    (sequelize.models.OpenReceivePayment as ReturnType<typeof initOpenReceivePayment> | undefined);
  if (!Payment) {
    throw new Error("Call initOpenReceivePayment(sequelize) during boot before creating hooks.");
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
        await sequelize.query(
          \`SELECT id FROM "${options.orderTable}" WHERE id = :id FOR UPDATE\`,
          { replacements: { id: values.orderId }, transaction },
        );

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
            swapData: values.swapData ?? null,
          },
          { transaction },
        );
      });
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
  OpenReceivePayment?: ReturnType<typeof initOpenReceivePayment>,
): Promise<MarkPaidOnceResult> {
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
      rejectOnEmpty: true,
    });

    await sequelize.query(
      \`SELECT id FROM "${options.orderTable}" WHERE id = :id FOR UPDATE\`,
      { replacements: { id: payment.orderId }, transaction },
    );

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
    { path: "src/openreceive/hooks.stub.ts", contents: hooksStubContents() },
    { path: "OPENRECEIVE_PAYMENTS.md", contents: nextStepsMarkdown(options) },
  ];
}
