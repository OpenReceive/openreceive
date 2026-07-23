import {
  assertOrderModelName,
  assertOrderTableName,
  defaultOrderTable,
} from "./shared.ts";
import { defaultOrderIdType, finalizeScaffoldOptions } from "./parse-args.ts";
import {
  OPENRECEIVE_ORMS,
  ORDER_ID_TYPES,
  type OpenReceiveOrm,
  type OrderIdType,
  type ScaffoldPaymentsOptions,
} from "./types.ts";
import type { ParsedScaffoldArgv } from "./parse-args.ts";

export type ScaffoldPrompt = (question: string) => Promise<string>;

export async function resolveScaffoldPaymentsOptions(input: {
  readonly parsed: ParsedScaffoldArgv;
  readonly canPrompt: boolean;
  readonly prompt: ScaffoldPrompt;
}): Promise<ScaffoldPaymentsOptions> {
  const { partial } = input.parsed;
  const wantsWizard =
    input.parsed.interactive || (partial.orm === undefined && input.canPrompt);

  if (!wantsWizard) {
    return finalizeScaffoldOptions(partial);
  }

  if (!input.canPrompt) {
    throw new Error(
      "Interactive scaffold requires a TTY. Pass --orm explicitly for non-interactive use.",
    );
  }

  const orm =
    partial.orm ??
    (await promptChoice(
      input.prompt,
      "ORM",
      OPENRECEIVE_ORMS,
      undefined,
    ));

  const orderModel = assertOrderModelName(
    partial.orderModel ??
      (await promptText(input.prompt, "Host order model name", "Order")),
  );

  const orderTable = assertOrderTableName(
    partial.orderTable ??
      (await promptText(
        input.prompt,
        "Host order table name",
        defaultOrderTable(orderModel),
      )),
  );

  const orderIdType =
    partial.orderIdType ??
    (await promptChoice(
      input.prompt,
      "Order primary key type",
      ORDER_ID_TYPES,
      defaultOrderIdType(orm),
    ));

  const skipForeignKey =
    partial.skipForeignKey ||
    !(await promptYesNo(
      input.prompt,
      `Add a foreign key from openreceive_payments.order_id to ${orderTable}.id?`,
      true,
    ));

  const outDir =
    partial.outDir === "."
      ? await promptText(input.prompt, "Output directory", ".")
      : partial.outDir;

  return {
    orm,
    orderModel,
    orderTable,
    orderIdType,
    skipForeignKey,
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

async function promptYesNo(
  prompt: ScaffoldPrompt,
  label: string,
  fallback: boolean,
): Promise<boolean> {
  const hint = fallback ? "Y/n" : "y/N";
  const answer = (await prompt(`${label} (${hint}): `)).trim().toLowerCase();
  if (answer.length === 0) return fallback;
  if (["y", "yes"].includes(answer)) return true;
  if (["n", "no"].includes(answer)) return false;
  throw new Error(`Please answer yes or no for: ${label}`);
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

export type { OpenReceiveOrm, OrderIdType };
