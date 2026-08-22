import { finalizeScaffoldOptions } from "./parse-args.ts";
import { OPENRECEIVE_DIALECTS, OPENRECEIVE_ORMS, type ScaffoldPaymentsOptions } from "./types.ts";
import type { ParsedScaffoldArgv } from "./parse-args.ts";

export type ScaffoldPrompt = (question: string) => Promise<string>;

export async function resolveScaffoldPaymentsOptions(input: {
  readonly parsed: ParsedScaffoldArgv;
  readonly canPrompt: boolean;
  readonly prompt: ScaffoldPrompt;
}): Promise<ScaffoldPaymentsOptions> {
  const { partial } = input.parsed;
  const wantsWizard = input.parsed.interactive || (partial.orm === undefined && input.canPrompt);

  if (!wantsWizard) {
    return finalizeScaffoldOptions(partial);
  }

  if (!input.canPrompt) {
    throw new Error(
      "Interactive scaffold requires a TTY. Pass --orm explicitly for non-interactive use.",
    );
  }

  const orm = partial.orm ?? (await promptChoice(input.prompt, "ORM", OPENRECEIVE_ORMS, undefined));

  const dialect =
    partial.dialect ??
    (await promptChoice(input.prompt, "SQL dialect", OPENRECEIVE_DIALECTS, "postgres"));

  const outDir =
    partial.outDir === "."
      ? await promptText(input.prompt, "Output directory", ".")
      : partial.outDir;

  return {
    orm,
    dialect,
    tableName: partial.tableName ?? "openreceive_payments",
    metaTableName: partial.metaTableName ?? "openreceive_meta",
    outDir,
    force: partial.force,
  };
}

async function promptText(
  prompt: ScaffoldPrompt,
  label: string,
  fallback: string,
): Promise<string> {
  const answer = (await prompt(`${label} [${fallback}]: `)).trim();
  return answer.length === 0 ? fallback : answer;
}

async function promptChoice<T extends string>(
  prompt: ScaffoldPrompt,
  label: string,
  choices: readonly T[],
  fallback: T | undefined,
): Promise<T> {
  const listed = choices.join(", ");
  const suffix = fallback === undefined ? "" : ` [${fallback}]`;
  const answer = (await prompt(`${label} (${listed})${suffix}: `)).trim().toLowerCase();
  const selected = answer.length === 0 ? fallback : answer;
  if (selected !== undefined && (choices as readonly string[]).includes(selected)) {
    return selected as T;
  }
  throw new Error(`${label} must be one of: ${listed}.`);
}
