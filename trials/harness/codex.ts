import { spawn } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentUsage, ParsedTurn, SeenWrite, TurnRequest, TurnResponse } from "./cursor.ts";
import { InfraError } from "./docker.ts";
import type { ToolEvent } from "./types.ts";

// The Codex CLI in exec mode. One turn is one `codex exec` process; the next
// merchant reply resumes its thread.

interface CodexItem {
  readonly type?: string;
  readonly text?: string;
  readonly command?: string;
  readonly aggregated_output?: string;
  readonly exit_code?: number | null;
  readonly changes?: readonly { readonly path?: string }[];
}

const OUTPUT_TAIL = 2000;

/** Codex runs each command as `/bin/bash -lc '<command>'`; the checks read the command itself. */
export function unwrapShell(command: string): string {
  const quoted = command.match(/^\/bin\/(?:ba)?sh -l?c '([\s\S]*)'$/)?.[1];
  if (quoted !== undefined) return quoted.replaceAll(`'\\''`, "'");
  const doubled = command.match(/^\/bin\/(?:ba)?sh -l?c "([\s\S]*)"$/)?.[1];
  if (doubled !== undefined) return doubled.replace(/\\(["\\$`])/g, "$1");
  return command;
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL ? trimmed.slice(-OUTPUT_TAIL) : trimmed;
}

/** Parse one `codex exec --json` turn. Unknown lines are ignored. */
export function parseCodexStream(raw: string): ParsedTurn {
  const texts: string[] = [];
  const tools: ToolEvent[] = [];
  const writes: SeenWrite[] = [];
  const toolNames: string[] = [];
  const usage: AgentUsage = { inputTokens: 0, outputTokens: 0 };
  let sessionId: string | undefined;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      sessionId = event.thread_id;
    }
    if (event.type === "turn.completed") {
      const reported = event.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      usage.inputTokens += reported?.input_tokens ?? 0;
      usage.outputTokens += reported?.output_tokens ?? 0;
    }
    if (event.type !== "item.completed") continue;
    const item = (event.item ?? {}) as CodexItem;
    if (item.type === "agent_message" && typeof item.text === "string") texts.push(item.text);
    if (item.type === "command_execution" && typeof item.command === "string") {
      toolNames.push("command_execution");
      tools.push({
        type: "shell",
        command: unwrapShell(item.command),
        exitCode: typeof item.exit_code === "number" ? item.exit_code : undefined,
        output: tail(item.aggregated_output ?? ""),
      });
    }
    if (item.type === "file_change") {
      toolNames.push("file_change");
      for (const change of item.changes ?? []) {
        if (typeof change.path === "string") {
          tools.push({ type: "write", path: change.path, tracked: false });
        }
      }
    }
  }

  const text = texts.join("\n");
  return {
    sessionId,
    text,
    lastText: texts.at(-1) ?? "",
    tools,
    writes,
    usage,
    model: undefined,
    toolNames,
  };
}

/** No user config (MCP servers, hooks, profiles): the agent sees the shop and the shell. */
function codexArgs(request: TurnRequest): string[] {
  const flags = [
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "--ignore-user-config",
  ];
  if (request.model !== undefined) flags.push("--model", request.model);
  return request.resume === undefined
    ? ["exec", ...flags, "--cd", request.workspace, request.prompt]
    : ["exec", "resume", ...flags, request.resume, request.prompt];
}

/** The threads each shop's trial used, so they can be deleted with the shop. */
const threads = new Map<string, Set<string>>();

export function codexTurn(request: TurnRequest): Promise<TurnResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", codexArgs(request), {
      cwd: request.workspace,
      env: request.env,
      // Codex reads stdin when it is open; a trial has nothing more to say.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let raw = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, request.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      raw += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new InfraError(error.message));
    });
    child.on("close", () => {
      clearTimeout(timer);
      const parsed = parseCodexStream(raw);
      if (parsed.sessionId === undefined && parsed.text.length === 0 && !timedOut) {
        reject(new InfraError(stderr.trim() || "Codex returned no thread and no message."));
        return;
      }
      const sessionId = parsed.sessionId ?? request.resume;
      if (sessionId !== undefined) {
        const own = threads.get(request.workspace) ?? new Set<string>();
        own.add(sessionId);
        threads.set(request.workspace, own);
      }
      resolve({ ...parsed, sessionId, raw, timedOut });
    });
  });
}

export function codexPreflight(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["login", "status"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", () => reject(new InfraError("The Codex CLI (`codex`) is not installed.")));
    child.on("close", (code) => {
      if (code !== 0 || !/logged in/i.test(out)) {
        reject(new InfraError("Codex is not logged in. Run `codex login`."));
        return;
      }
      const version = spawn("codex", ["--version"], { env, stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      version.stdout.setEncoding("utf8");
      version.stdout.on("data", (chunk: string) => {
        text += chunk;
      });
      version.on("close", () => resolve(text.trim()));
    });
  });
}

/** Codex saves each thread as ~/.codex/sessions/<y>/<m>/<d>/rollout-…-<thread id>.jsonl. */
export async function forgetCodexThreads(workspace: string): Promise<void> {
  const own = threads.get(workspace);
  threads.delete(workspace);
  if (own === undefined || own.size === 0) return;
  const root = path.join(homedir(), ".codex", "sessions");
  const entries = await readdir(root, { recursive: true }).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((entry) => [...own].some((id) => entry.endsWith(`${id}.jsonl`)))
      .map((entry) => rm(path.join(root, entry), { force: true })),
  );
}
