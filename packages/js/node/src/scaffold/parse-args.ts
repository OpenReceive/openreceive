import {
  assertOrderModelName,
  assertOrderTableName,
  defaultOrderTable,
} from "./shared.ts";
import {
  OPENRECEIVE_DIALECTS,
  OPENRECEIVE_ORMS,
  ORDER_ID_TYPES,
  type OpenReceiveDialect,
  type OpenReceiveOrm,
  type OrderIdType,
  type ScaffoldPaymentsOptions,
} from "./types.ts";

export interface ParsedScaffoldArgv {
  readonly help: boolean;
  readonly interactive: boolean;
  readonly partial: Partial<ScaffoldPaymentsOptions> & {
    readonly force: boolean;
    readonly skipForeignKey: boolean;
    readonly outDir: string;
  };
}

export function parseScaffoldPaymentsArgv(argv: readonly string[]): ParsedScaffoldArgv {
  let help = false;
  let interactive = false;
  let orm: OpenReceiveOrm | undefined;
  let dialect: OpenReceiveDialect | undefined;
  let orderModel: string | undefined;
  let orderTable: string | undefined;
  let orderIdType: OrderIdType | undefined;
  let skipForeignKey = false;
  let force = false;
  let outDir = ".";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--interactive" || arg === "-i") {
      interactive = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--skip-foreign-key") {
      skipForeignKey = true;
      continue;
    }
    if (arg === "--orm") {
      orm = readEnum(argv[++index], OPENRECEIVE_ORMS, "--orm");
      continue;
    }
    if (arg.startsWith("--orm=")) {
      orm = readEnum(arg.slice("--orm=".length), OPENRECEIVE_ORMS, "--orm");
      continue;
    }
    if (arg === "--dialect") {
      dialect = readEnum(argv[++index], OPENRECEIVE_DIALECTS, "--dialect");
      continue;
    }
    if (arg.startsWith("--dialect=")) {
      dialect = readEnum(arg.slice("--dialect=".length), OPENRECEIVE_DIALECTS, "--dialect");
      continue;
    }
    if (arg === "--order-model") {
      orderModel = assertOrderModelName(requiredValue(argv[++index], "--order-model"));
      continue;
    }
    if (arg.startsWith("--order-model=")) {
      orderModel = assertOrderModelName(arg.slice("--order-model=".length));
      continue;
    }
    if (arg === "--order-table") {
      orderTable = assertOrderTableName(requiredValue(argv[++index], "--order-table"));
      continue;
    }
    if (arg.startsWith("--order-table=")) {
      orderTable = assertOrderTableName(arg.slice("--order-table=".length));
      continue;
    }
    if (arg === "--order-id-type") {
      orderIdType = readEnum(argv[++index], ORDER_ID_TYPES, "--order-id-type");
      continue;
    }
    if (arg.startsWith("--order-id-type=")) {
      orderIdType = readEnum(arg.slice("--order-id-type=".length), ORDER_ID_TYPES, "--order-id-type");
      continue;
    }
    if (arg === "--out-dir") {
      outDir = requiredValue(argv[++index], "--out-dir");
      continue;
    }
    if (arg.startsWith("--out-dir=")) {
      outDir = arg.slice("--out-dir=".length);
      if (!outDir) throw new Error("--out-dir requires a path.");
      continue;
    }
    throw new Error(`Unexpected option: ${arg}`);
  }

  return {
    help,
    interactive,
    partial: {
      ...(orm === undefined ? {} : { orm }),
      ...(dialect === undefined ? {} : { dialect }),
      ...(orderModel === undefined ? {} : { orderModel }),
      ...(orderTable === undefined ? {} : { orderTable }),
      ...(orderIdType === undefined ? {} : { orderIdType }),
      skipForeignKey,
      force,
      outDir,
    },
  };
}

export function finalizeScaffoldOptions(
  partial: ParsedScaffoldArgv["partial"],
): ScaffoldPaymentsOptions {
  if (partial.orm === undefined) {
    throw new Error(
      "Missing --orm. Use --orm prisma|drizzle|typeorm|sequelize|knex, or run with --interactive.",
    );
  }
  const orderModel = assertOrderModelName(partial.orderModel ?? "Order");
  const orderTable = assertOrderTableName(
    partial.orderTable ?? defaultOrderTable(orderModel),
  );
  const orderIdType = partial.orderIdType ?? defaultOrderIdType(partial.orm);
  return {
    orm: partial.orm,
    dialect: partial.dialect ?? "postgres",
    orderModel,
    orderTable,
    orderIdType,
    skipForeignKey: partial.skipForeignKey,
    outDir: partial.outDir,
    force: partial.force,
  };
}

export function defaultOrderIdType(orm: OpenReceiveOrm): OrderIdType {
  return orm === "prisma" || orm === "typeorm" ? "string" : "bigint";
}

function requiredValue(value: string | undefined, flag: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function readEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
): T {
  const raw = requiredValue(value, flag);
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new Error(`${flag} must be one of: ${allowed.join(", ")}.`);
}
