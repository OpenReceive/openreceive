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
  readonly agent: string;
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
        agent: input.agent,
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
      const body = [
        hide(turn.text, input.uris),
        ...commands.map((command) => hide(command, input.uris)),
      ];
      return `## ${turn.role}\n\n${body.join("\n\n")}`;
    })
    .join("\n\n");
  await writeFile(path.join(input.directory, "transcript.md"), `${transcript}\n`);

  const commands = input.turns
    .flatMap((turn) => turn.tools ?? [])
    .map((tool) => {
      if (tool.type !== "shell") return undefined;
      const exit = tool.exitCode === undefined ? "" : `[exit ${tool.exitCode}] `;
      return `${exit}${hide(tool.command, input.uris)}`;
    })
    .filter((line): line is string => line !== undefined);
  await writeFile(path.join(input.directory, "commands.txt"), `${commands.join("\n")}\n`);
  await writeFile(
    path.join(input.directory, "stream.jsonl"),
    `${input.rawStreams.map((stream) => hide(stream, input.uris)).join("")}\n`,
  );
}

export interface SummaryRun {
  readonly id: string;
  readonly elapsedMs?: number;
  readonly checks: readonly Check[];
  /** Docker, the Cursor CLI or the plain shop failed: the agent never ran, or never finished. */
  readonly infra?: boolean;
  readonly message?: string;
}

export interface PlatformSummary {
  readonly slug: string;
  readonly day: string;
  readonly mode: string;
  readonly release: string;
  readonly directionsUrl: string;
  /** The first 12 hex digits of the directions file's SHA-256, as the agent fetched it. */
  readonly directions: string;
  readonly runs: readonly (SummaryRun & {
    readonly ok: boolean;
    readonly agent: string;
    readonly model: string;
  })[];
}

/**
 * One platform's trials. When every trial passed, it ends with the entry to
 * put in passed.json: how many trials passed, the agents and models that ran
 * them (`agent/model`), and which directions file they followed.
 */
export function platformSummaryMarkdown(summary: PlatformSummary): string {
  const passed = summary.runs.filter((run) => run.ok).length;
  const agents = [...new Set(summary.runs.map((run) => `${run.agent}/${run.model}`))].sort();
  const lines = [
    `# ${summary.slug}: ${passed} of ${summary.runs.length} trials passed`,
    "",
    `- agents: ${agents.join(", ")}`,
    `- mode: ${summary.mode}`,
    `- directions: ${summary.directionsUrl} (sha256 ${summary.directions})`,
    `- packages: whatever the registries served on ${summary.day}; latest release ${summary.release}`,
    "",
  ];
  if (passed === summary.runs.length) {
    const entry = {
      trial: summary.slug,
      date: summary.day,
      release: summary.release,
      runs: summary.runs.length,
      agents,
      mode: summary.mode,
      directions: summary.directions,
    };
    lines.push("passed.json entry:", "", "```json", JSON.stringify(entry), "```", "");
  }
  const runs = summary.runs.map((run) => ({ ...run, id: `${run.id} (${run.agent}/${run.model})` }));
  return `${lines.join("\n")}\n${summaryMarkdown(runs)}`;
}

export function summaryMarkdown(runs: readonly SummaryRun[]): string {
  const blocks = runs.map((run) => {
    const blockers = run.checks.filter(
      (check) => check.severity === "blocker" && check.pass === false,
    );
    const polish = run.checks.filter(
      (check) => check.severity === "polish" && check.pass === false,
    );
    const passed = run.checks.filter((check) => check.pass);
    const minutes =
      run.elapsedMs === undefined ? "" : ` (${(run.elapsedMs / 60_000).toFixed(1)} min)`;
    const lines = [`## ${run.id}${minutes}`, ""];
    if (run.infra === true) {
      lines.push(`Infrastructure, not a directions result: ${run.message ?? "unknown"}`, "");
    } else if (blockers.length === 0) lines.push("No blockers.", "");
    else {
      lines.push("Blockers", "");
      for (const check of blockers) {
        const quote = check.evidence === undefined ? check.summary : check.evidence;
        lines.push(`- ${check.id}: ${quote}`);
      }
      lines.push("");
    }
    if (polish.length > 0) {
      lines.push("Polish", "");
      for (const check of polish) {
        lines.push(`- ${check.id}: ${check.summary}`);
        if (check.evidence !== undefined)
          lines.push(`  ${check.evidence.replaceAll("\n", "\n  ")}`);
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
