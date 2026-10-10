import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { finalizeScaffoldOptions, parseScaffoldPaymentsArgv } from "./parse-args.ts";
import { renderScaffoldPaymentsFiles } from "./render.ts";
import { renderSupabaseFiles, supabaseMigrationPath } from "./supabase.ts";
import type { ScaffoldPrompt } from "./wizard.ts";
import { resolveScaffoldPaymentsOptions } from "./wizard.ts";
import { writeScaffoldFiles } from "./write-files.ts";
import type { ScaffoldPaymentsOptions, ScaffoldResult } from "./types.ts";

export const SCAFFOLD_PAYMENTS_HELP = `
Usage: openreceive scaffold payments [options]

Emits one schema/migration file for your ORM — openreceive_payments and the
openreceive_meta reconcile gate together — plus an OPENRECEIVE_PAYMENTS.md
wiring guide, nothing else. With --supabase it emits a Supabase migration
instead, for servers that reach Supabase over its HTTPS API (Cloudflare
Workers, Lovable). OpenReceive owns the
payment-attempt repository logic (locking, settlement write-once,
reconciliation) at runtime; the generated files never contain it.
OpenReceive never opens a database connection or runs migrations.

Options:
  --orm <name>              prisma | drizzle | typeorm | sequelize | knex
  --supabase                supabase/migrations/<timestamp>_openreceive.sql:
                            the tables, locked away from the Data API, plus
                            the functions storage: { supabase } calls
  --dialect <name>          postgres | sqlite (default: postgres)
  --table-name <name>       Payment attempts table (default: openreceive_payments)
  --meta-table-name <name>  Reconcile-gate table (default: openreceive_meta)
  --out-dir <path>          Output root (default: .)
  --force                   Overwrite existing generated files
  -i, --interactive         Ask for missing options (default on TTY when --orm omitted)
  -h, --help                Show this help

Examples:
  npx openreceive scaffold payments
  npx openreceive scaffold payments --orm prisma
  npx openreceive scaffold payments --orm knex --dialect sqlite
  npx openreceive scaffold payments --orm drizzle --dialect sqlite --out-dir ./backend
  npx openreceive scaffold payments --supabase
`.trim();

export interface RunScaffoldPaymentsInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly stdout: { write(message: string): void };
  readonly stderr: { write(message: string): void };
  readonly stdin?: NodeJS.ReadableStream;
  readonly isTTY?: boolean;
  readonly prompt?: ScaffoldPrompt;
  /** The clock that stamps a new Supabase migration's file name. */
  readonly now?: () => Date;
}

export async function runScaffoldPayments(input: RunScaffoldPaymentsInput): Promise<number> {
  const parsed = parseScaffoldPaymentsArgv(input.argv);
  if (parsed.help) {
    input.stdout.write(`${SCAFFOLD_PAYMENTS_HELP}\n`);
    return 0;
  }
  if (parsed.supabase) return runSupabaseScaffold(input, parsed.partial);

  const canPrompt =
    input.isTTY ??
    Boolean(
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

  printPlan(input.stdout, options);

  const files = renderScaffoldPaymentsFiles(options);
  const result = await writeScaffoldFiles({
    cwd: input.cwd,
    outDir: options.outDir,
    force: options.force,
    files,
  });

  printSummary(input.stdout, options, result);
  return 0;
}

async function runSupabaseScaffold(
  input: RunScaffoldPaymentsInput,
  options: { readonly outDir: string; readonly force: boolean },
): Promise<number> {
  const root = path.resolve(input.cwd, options.outDir);
  const migration = await supabaseMigrationPath(root, input.now?.() ?? new Date());
  input.stdout.write("OpenReceive scaffold payments --supabase\n");
  input.stdout.write(`  out-dir:      ${options.outDir}\n`);
  input.stdout.write("\nWriting files…\n");
  const result = await writeScaffoldFiles({
    cwd: input.cwd,
    outDir: options.outDir,
    force: options.force,
    files: renderSupabaseFiles(migration),
  });
  for (const file of result.written) input.stdout.write(`  wrote ${file}\n`);
  input.stdout.write("\nDone.\n");
  input.stdout.write("Next:\n");
  input.stdout.write("  1. Read OPENRECEIVE_PAYMENTS.md\n");
  input.stdout.write("  2. Apply the migration (supabase db push, or the SQL Editor)\n");
  input.stdout.write(
    "  3. Replace public.openreceive_on_paid, in a migration of your own, with the\n" +
      "     SQL that marks the order paid; until then every settlement is refused\n",
  );
  input.stdout.write(
    "  4. Wire createStack({ storage: { supabase: { url, key } }, ... }) with the\n" +
      "     project's secret key, kept on the server\n",
  );
  return 0;
}

function printPlan(
  stdout: { write(message: string): void },
  options: ScaffoldPaymentsOptions,
): void {
  stdout.write("OpenReceive scaffold payments\n");
  stdout.write(`  orm:          ${options.orm}\n`);
  stdout.write(`  dialect:      ${options.dialect}\n`);
  stdout.write(`  tables:       ${options.tableName}, ${options.metaTableName}\n`);
  stdout.write(`  out-dir:      ${options.outDir}\n`);
  if (options.dialect === "sqlite") {
    stdout.write(
      "  note:         SQLite uses a single-writer transaction (no Postgres row locks)\n",
    );
  }
  stdout.write("\nWriting files…\n");
}

function printSummary(
  stdout: { write(message: string): void },
  options: ScaffoldPaymentsOptions,
  result: ScaffoldResult,
): void {
  for (const file of result.written) {
    stdout.write(`  wrote ${file}\n`);
  }
  stdout.write("\nDone.\n");
  stdout.write("Next:\n");
  stdout.write("  1. Read OPENRECEIVE_PAYMENTS.md\n");
  stdout.write(`  2. Run the schema/migration through your normal ${options.orm} workflow\n`);
  stdout.write(
    "  3. Wire createHost({ db, amountFor, onPaid }) —\n" +
      "     OpenReceive owns the repository logic at runtime; settlement piggybacks\n" +
      "     on mounted routes by default (no background process needed)\n",
  );
  stdout.write(
    "  4. Make onPaid idempotent if anything OTHER than OpenReceive can also\n" +
      "     fulfill an order — the generated files show the guarded UPDATE\n",
  );
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
