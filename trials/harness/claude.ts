import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentUsage, ParsedTurn, SeenWrite, TurnRequest, TurnResponse } from "./cursor.ts";
import { InfraError } from "./docker.ts";
import type { ToolEvent } from "./types.ts";

// Claude Code in print mode, the agent the filmed trials use. One turn is one
// `claude -p` process; the next merchant reply resumes its session.

interface ContentBlock {
  readonly type?: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
  readonly tool_use_id?: string;
  readonly content?: unknown;
  readonly is_error?: boolean;
}

const OUTPUT_TAIL = 2000;

function stringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) =>
      item !== null && typeof item === "object" && typeof (item as ContentBlock).text === "string"
        ? (item as ContentBlock).text
        : "",
    )
    .join("\n");
}

/** A failed Bash call reports "Exit code N" first; a timeout or interrupt has none. */
function exitCodeOf(block: ContentBlock): number {
  if (block.is_error !== true) return 0;
  const code = resultText(block.content).match(/^(?:Error: )?Exit code (\d+)/)?.[1];
  return code === undefined ? 1 : Number(code);
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL ? trimmed.slice(-OUTPUT_TAIL) : trimmed;
}

/** Parse one `claude -p --output-format stream-json --verbose` turn. Unknown lines are ignored. */
export function parseClaudeStream(raw: string): ParsedTurn {
  const texts: string[] = [];
  const tools: ToolEvent[] = [];
  const writes: SeenWrite[] = [];
  const toolNames: string[] = [];
  const usage: AgentUsage = { inputTokens: 0, outputTokens: 0 };
  const pending = new Map<string, { name: string; input: Record<string, unknown> }>();
  let sessionId: string | undefined;
  let model: string | undefined;
  let resultMessage = "";

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof event.session_id === "string") sessionId = event.session_id;
    if (event.type === "system" && typeof event.model === "string") model = event.model;
    const message = event.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(message?.content) ? (message.content as ContentBlock[]) : [];
    if (event.type === "assistant") {
      const text = blocks
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
      if (text.length > 0) texts.push(text);
      for (const block of blocks) {
        if (block.type !== "tool_use" || block.id === undefined || block.name === undefined)
          continue;
        toolNames.push(block.name);
        pending.set(block.id, { name: block.name, input: block.input ?? {} });
        const filePath = stringArg(block.input, "file_path");
        const content =
          stringArg(block.input, "content") ?? stringArg(block.input, "new_string") ?? undefined;
        if (filePath !== undefined && content !== undefined) {
          tools.push({ type: "write", path: filePath, tracked: false });
          writes.push({ path: filePath, content });
        }
        const url = stringArg(block.input, "url");
        if (url !== undefined) tools.push({ type: "fetch", url });
      }
    }
    if (event.type === "user") {
      for (const block of blocks) {
        if (block.type !== "tool_result" || block.tool_use_id === undefined) continue;
        const call = pending.get(block.tool_use_id);
        if (call?.name !== "Bash") continue;
        const command = stringArg(call.input, "command");
        if (command === undefined) continue;
        tools.push({
          type: "shell",
          command,
          exitCode: exitCodeOf(block),
          output: tail(resultText(block.content)),
        });
      }
    }
    if (event.type === "result") {
      const reported = event.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      usage.inputTokens += reported?.input_tokens ?? 0;
      usage.outputTokens += reported?.output_tokens ?? 0;
      if (typeof event.result === "string") resultMessage = event.result;
    }
  }

  return {
    sessionId,
    text: texts.length > 0 ? texts.join("\n") : resultMessage,
    lastText: texts.at(-1) ?? resultMessage,
    tools,
    writes,
    usage,
    model,
    toolNames,
  };
}

/**
 * No MCP servers and no user-level settings (hooks, plugins): the agent under
 * test sees the shop and the shell, not the operator's own connectors.
 */
function claudeArgs(request: TurnRequest): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--strict-mcp-config",
    "--setting-sources",
    "project,local",
  ];
  if (request.model !== undefined) args.push("--model", request.model);
  if (request.resume !== undefined) args.push("--resume", request.resume);
  args.push(request.prompt);
  return args;
}

export function claudeTurn(request: TurnRequest): Promise<TurnResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", claudeArgs(request), {
      cwd: request.workspace,
      env: request.env,
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
      const parsed = parseClaudeStream(raw);
      if (parsed.sessionId === undefined && parsed.text.length === 0 && !timedOut) {
        reject(new InfraError(stderr.trim() || "Claude Code returned no session and no message."));
        return;
      }
      resolve({ ...parsed, raw, timedOut });
    });
  });
}

export function claudePreflight(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["--version"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", () =>
      reject(new InfraError("The Claude Code CLI (`claude`) is not installed.")),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new InfraError(`claude --version exited ${code}. Run \`claude\` and log in.`)),
    );
  });
}

/**
 * Claude Code keeps each project's sessions and memory under
 * ~/.claude/projects/<path with every non-alphanumeric character as "-">.
 * A trial's shop directory is thrown away, so its folder there goes too.
 */
export async function forgetClaudeProject(workspace: string): Promise<void> {
  const name = path.resolve(workspace).replace(/[^A-Za-z0-9]/g, "-");
  await rm(path.join(homedir(), ".claude", "projects", name), { recursive: true, force: true });
}
