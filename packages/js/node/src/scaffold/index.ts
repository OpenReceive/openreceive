import { createInterface } from "node:readline/promises";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import {
  finalizeScaffoldOptions,
  parseScaffoldPaymentsArgv,
} from "./parse-args.ts";
import { renderScaffoldPaymentsFiles } from "./render.ts";
import type { ScaffoldPrompt } from "./wizard.ts";
import { resolveScaffoldPaymentsOptions } from "./wizard.ts";
import { writeScaffoldFiles } from "./write-files.ts";
import type { ScaffoldResult } from "./types.ts";

export const SCAFFOLD_PAYMENTS_HELP = `
Usage: openreceive scaffold payments [options]

Scaffolds a host-owned openreceive_payments model plus repository helpers.
OpenReceive never opens a database connection or runs migrations.

Options:
  --orm <name>              prisma | drizzle | typeorm | sequelize | knex
  --order-model <Name>      Host order model/class (default: Order)
  --order-table <name>      Host order table (default: derived)
  --order-id-type <type>    bigint | integer | uuid | string
  --out-dir <path>          Output root (default: .)
  --skip-foreign-key        Do not emit a FK to the order table
  --force                   Overwrite existing generated files
  -i, --interactive         Ask for missing options (default on TTY when --orm omitted)
  -h, --help                Show this help

Examples:
  npx openreceive scaffold payments
  npx openreceive scaffold payments --orm prisma
  npx openreceive scaffold payments --orm sequelize --order-model Purchase --order-id-type uuid
  npx openreceive scaffold payments --orm knex --skip-foreign-key --out-dir ./backend
`.trim();

export interface RunScaffoldPaymentsInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly stdout: { write(message: string): void };
  readonly stderr: { write(message: string): void };
  readonly stdin?: NodeJS.ReadableStream;
  readonly isTTY?: boolean;
  readonly prompt?: ScaffoldPrompt;
}

export async function runScaffoldPayments(
  input: RunScaffoldPaymentsInput,
): Promise<number> {
  const parsed = parseScaffoldPaymentsArgv(input.argv);
  if (parsed.help) {
    input.stdout.write(`${SCAFFOLD_PAYMENTS_HELP}\n`);
    return 0;
  }

  const canPrompt = input.isTTY ?? Boolean(
    (input.stdin as { isTTY?: boolean } | undefined)?.isTTY ??
      (defaultStdin as { isTTY?: boolean }).isTTY,
  );

  const prompt = input.prompt ?? createReadlinePrompt(input);
  const options = await resolveScaffoldPaymentsOptions({
    parsed,
    canPrompt,
    prompt,
  });

  // Non-interactive path still goes through finalize via wizard when orm set;
  // re-validate for consistent errors when flags alone are used without TTY.
  finalizeScaffoldOptions(options);

  const files = renderScaffoldPaymentsFiles(options);
  const result = await writeScaffoldFiles({
    cwd: input.cwd,
    outDir: options.outDir,
    force: options.force,
    files,
  });

  printSummary(input.stdout, options.orm, result);
  return 0;
}

function printSummary(
  stdout: { write(message: string): void },
  orm: string,
  result: ScaffoldResult,
): void {
  stdout.write(`OpenReceive scaffold payments (${orm})\n`);
  for (const file of result.written) {
    stdout.write(`  wrote ${file}\n`);
  }
  stdout.write("Next: read OPENRECEIVE_PAYMENTS.md, merge/migrate, then fill hooks.stub.ts.\n");
}

function createReadlinePrompt(input: RunScaffoldPaymentsInput): ScaffoldPrompt {
  return async (question) => {
    const rl = createInterface({
      input: (input.stdin as NodeJS.ReadableStream | undefined) ?? defaultStdin,
      output: defaultStdout,
      terminal: input.isTTY ?? true,
    });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}

export {
  finalizeScaffoldOptions,
  parseScaffoldPaymentsArgv,
} from "./parse-args.ts";
export { renderScaffoldPaymentsFiles } from "./render.ts";
export type {
  OpenReceiveOrm,
  OrderIdType,
  ScaffoldFile,
  ScaffoldPaymentsOptions,
  ScaffoldResult,
} from "./types.ts";
