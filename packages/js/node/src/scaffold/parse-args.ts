import { assertPaymentsTableName } from "./shared.ts";
import {
  OPENRECEIVE_DIALECTS,
  OPENRECEIVE_ORMS,
  type Dialect,
  type Orm,
  type ScaffoldPaymentsOptions,
} from "./types.ts";

export interface ParsedScaffoldArgv {
  readonly help: boolean;
  readonly interactive: boolean;
  readonly partial: Partial<ScaffoldPaymentsOptions> & {
    readonly force: boolean;
    readonly outDir: string;
  };
}

export function parseScaffoldPaymentsArgv(argv: readonly string[]): ParsedScaffoldArgv {
  let help = false;
  let interactive = false;
  let orm: Orm | undefined;
  let dialect: Dialect | undefined;
  let tableName: string | undefined;
  let metaTableName: string | undefined;
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
    if (arg === "--table-name") {
      tableName = assertPaymentsTableName(
        requiredValue(argv[++index], "--table-name"),
        "--table-name",
      );
      continue;
    }
    if (arg.startsWith("--table-name=")) {
      tableName = assertPaymentsTableName(arg.slice("--table-name=".length), "--table-name");
      continue;
    }
    if (arg === "--meta-table-name") {
      metaTableName = assertPaymentsTableName(
        requiredValue(argv[++index], "--meta-table-name"),
        "--meta-table-name",
      );
      continue;
    }
    if (arg.startsWith("--meta-table-name=")) {
      metaTableName = assertPaymentsTableName(
        arg.slice("--meta-table-name=".length),
        "--meta-table-name",
      );
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
      ...(tableName === undefined ? {} : { tableName }),
      ...(metaTableName === undefined ? {} : { metaTableName }),
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
  return {
    orm: partial.orm,
    dialect: partial.dialect ?? "postgres",
    tableName: assertPaymentsTableName(partial.tableName ?? "openreceive_payments", "--table-name"),
    metaTableName: assertPaymentsTableName(
      partial.metaTableName ?? "openreceive_meta",
      "--meta-table-name",
    ),
    outDir: partial.outDir,
    force: partial.force,
  };
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
