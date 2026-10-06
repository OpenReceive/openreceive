import { spawn } from "node:child_process";
import { InfraError } from "./docker.ts";
import type { ToolEvent } from "./types.ts";

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface SeenWrite {
  readonly path: string;
  readonly content: string;
}

export interface ParsedTurn {
  readonly sessionId?: string;
  readonly text: string;
  /** The last assistant bubble. The merchant answers this one. */
  readonly lastText: string;
  readonly tools: ToolEvent[];
  readonly writes: readonly SeenWrite[];
  readonly usage: AgentUsage;
  readonly model?: string;
  readonly toolNames: readonly string[];
}

interface ToolCallBody {
  readonly args?: Record<string, unknown>;
  readonly result?: { readonly success?: { readonly exitCode?: number } };
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (item === null || typeof item !== "object") return "";
      const record = item as { type?: string; text?: string };
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter((item) => item.length > 0)
    .join("\n");
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const RELEASE_ZIP = /https:\/\/github\.com\/OpenReceive\/openreceive\/releases\/download\/\S+/i;

function eventsFromTool(
  name: string,
  body: ToolCallBody,
): { tools: ToolEvent[]; write?: SeenWrite } {
  const args = body.args ?? {};
  if (name === "shellToolCall") {
    const command = stringArg(args, "command");
    if (command === undefined) return { tools: [] };
    const tools: ToolEvent[] = [{ type: "shell", command }];
    const url = command.match(RELEASE_ZIP)?.[0];
    const exitCode = body.result?.success?.exitCode;
    if (url !== undefined && exitCode !== undefined && exitCode !== 0) {
      tools.push({ type: "fetch", url, status: 404 });
    }
    return { tools };
  }
  const filePath = stringArg(args, "path");
  const content = ["streamContent", "contents", "content", "text"]
    .map((key) => stringArg(args, key))
    .find((value) => value !== undefined);
  if (filePath !== undefined && content !== undefined && name !== "deleteToolCall") {
    return {
      tools: [{ type: "write", path: filePath, tracked: false }],
      write: { path: filePath, content },
    };
  }
  const url = stringArg(args, "url");
  if (url !== undefined) return { tools: [{ type: "fetch", url }] };
  return { tools: [] };
}

/** Parse one Cursor `--output-format stream-json` turn. Unknown lines are ignored. */
export function parseStream(raw: string): ParsedTurn {
  const texts: string[] = [];
  const tools: ToolEvent[] = [];
  const writes: SeenWrite[] = [];
  const toolNames: string[] = [];
  const usage: AgentUsage = { inputTokens: 0, outputTokens: 0 };
  let sessionId: string | undefined;
  let model: string | undefined;
  let resultText = "";

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
    if (event.type === "assistant") {
      const message = event.message as { content?: unknown } | undefined;
      const text = textFromContent(message?.content);
      if (text.length > 0) texts.push(text);
    }
    if (event.type === "result") {
      const reported = event.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      usage.inputTokens += reported?.inputTokens ?? 0;
      usage.outputTokens += reported?.outputTokens ?? 0;
      if (typeof event.result === "string") resultText = event.result;
    }
    if (event.type !== "tool_call" || event.subtype !== "completed") continue;
    const call = event.tool_call;
    if (call === null || typeof call !== "object") continue;
    for (const [name, value] of Object.entries(call)) {
      if (!name.endsWith("ToolCall") || value === null || typeof value !== "object") continue;
      toolNames.push(name);
      const extracted = eventsFromTool(name, value as ToolCallBody);
      tools.push(...extracted.tools);
      if (extracted.write !== undefined) writes.push(extracted.write);
    }
  }

  const text = texts.length > 0 ? texts.join("\n") : resultText;
  return {
    sessionId,
    text,
    lastText: texts.at(-1) ?? resultText,
    tools,
    writes,
    usage,
    model,
    toolNames,
  };
}

export interface TurnRequest {
  readonly workspace: string;
  readonly prompt: string;
  readonly resume?: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
}

export interface TurnResponse extends ParsedTurn {
  readonly raw: string;
  readonly timedOut: boolean;
}

const WALLET_ENV = new Set(["NWC_URI", "LSC_URI_PRIMARY", "LSC_URI_BACKUP"]);

function agentEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allow = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    if (WALLET_ENV.has(key)) continue;
    if (source[key] !== undefined) env[key] = source[key];
  }
  if (source.CURSOR_API_KEY !== undefined && !WALLET_ENV.has("CURSOR_API_KEY")) {
    env.CURSOR_API_KEY = source.CURSOR_API_KEY;
  }
  for (const key of WALLET_ENV) delete env[key];
  return env;
}

export function cursorEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return agentEnv(source);
}

function run(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("agent", [...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new InfraError(error.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new InfraError(stderr.trim() || stdout.trim() || `agent exited ${code}`));
    });
  });
}

export async function preflight(env: NodeJS.ProcessEnv = cursorEnv()): Promise<string> {
  let status: string;
  try {
    status = await run(["status"], env, 20_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not logged in|agent exited/i.test(message)) {
      throw new InfraError(`${message}\nRun \`agent login\` or set CURSOR_API_KEY.`);
    }
    throw new InfraError(
      message.includes("ENOENT")
        ? "The Cursor CLI (`agent`) is not installed."
        : `${message}\nRun \`agent login\` or set CURSOR_API_KEY.`,
    );
  }
  if (/not logged in/i.test(status)) {
    throw new InfraError("Cursor CLI is not logged in. Run `agent login` or set CURSOR_API_KEY.");
  }
  return run(["--version"], env, 20_000).then((version) => version.trim());
}

/** One print-mode turn. `--sandbox disabled` because the directions run Docker. */
export function agentTurn(request: TurnRequest): Promise<TurnResponse> {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--trust",
    "--force",
    "--sandbox",
    "disabled",
    "--workspace",
    request.workspace,
  ];
  if (request.model !== undefined) args.push("--model", request.model);
  if (request.resume !== undefined) args.push("--resume", request.resume);
  args.push(request.prompt);

  return new Promise((resolve, reject) => {
    const child = spawn("agent", args, {
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
      const parsed = parseStream(raw);
      if (parsed.sessionId === undefined && parsed.text.length === 0 && !timedOut) {
        reject(new InfraError(stderr.trim() || "Cursor returned no session and no message."));
        return;
      }
      resolve({ ...parsed, raw, timedOut });
    });
  });
}
