import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { redact } from "./redact.ts";
import type { Check, Turn } from "./types.ts";

export interface ReportInput {
  readonly directory: string;
  readonly slug: string;
  readonly id: string;
  readonly baseUrl: string;
  readonly directionsUrl: string;
  readonly agentVersion: string;
  readonly model?: string;
  readonly elapsedMs: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly toolNames: readonly string[];
  readonly turns: readonly Turn[];
  readonly rawStreams: readonly string[];
  readonly checks: readonly Check[];
  readonly uris: readonly string[];
}

function hide(text: string, uris: readonly string[]): string {
  return redact(text, uris);
}

export async function writeRunReport(input: ReportInput): Promise<void> {
  await mkdir(input.directory, { recursive: true });
  const checks = input.checks.map((check) => ({
    ...check,
    summary: hide(check.summary, input.uris),
    evidence: check.evidence === undefined ? undefined : hide(check.evidence, input.uris),
  }));
  await writeFile(
    path.join(input.directory, "result.json"),
    `${JSON.stringify(
      {
        slug: input.slug,
        id: input.id,
        baseUrl: input.baseUrl,
        directionsUrl: input.directionsUrl,
        agent: "cursor",
        agentVersion: input.agentVersion,
        model: input.model,
        elapsedMs: input.elapsedMs,
        usage: input.usage,
        toolNames: input.toolNames,
        checks,
      },
      null,
      2,
    )}\n`,
  );

  const transcript = input.turns
    .map((turn) => {
      const commands = (turn.tools ?? [])
        .filter((tool) => tool.type === "shell")
        .map((tool) => (tool.type === "shell" ? tool.command : ""))
        .filter((command) => command.length > 0);
      const body = [hide(turn.text, input.uris), ...commands.map((command) => hide(command, input.uris))];
      return `## ${turn.role}\n\n${body.join("\n\n")}`;
    })
    .join("\n\n");
  await writeFile(path.join(input.directory, "transcript.md"), `${transcript}\n`);

  const commands = input.turns
    .flatMap((turn) => turn.tools ?? [])
    .filter((tool) => tool.type === "shell")
    .map((tool) => (tool.type === "shell" ? hide(tool.command, input.uris) : ""));
  await writeFile(path.join(input.directory, "commands.txt"), `${commands.join("\n")}\n`);
  await writeFile(
    path.join(input.directory, "stream.jsonl"),
    `${input.rawStreams.map((stream) => hide(stream, input.uris)).join("")}\n`,
  );
}

export function summaryMarkdown(
  runs: readonly { readonly id: string; readonly checks: readonly Check[] }[],
): string {
  const blocks = runs.map((run) => {
    const blockers = run.checks.filter((check) => check.severity === "blocker" && check.pass === false);
    const passed = run.checks.filter((check) => check.pass);
    const lines = [`## ${run.id}`, ""];
    if (blockers.length === 0) lines.push("No blockers.", "");
    else {
      lines.push("Blockers", "");
      for (const check of blockers) {
        const quote = check.evidence === undefined ? check.summary : check.evidence;
        lines.push(`- ${check.id}: ${quote}`);
      }
      lines.push("");
    }
    if (passed.length > 0) {
      lines.push("Passed", "");
      for (const check of passed) lines.push(`- ${check.id}`);
      lines.push("");
    }
    return lines.join("\n");
  });
  return `${blocks.join("\n")}\n`;
}
