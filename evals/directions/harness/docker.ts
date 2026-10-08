import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export class InfraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfraError";
  }
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Beside the shop, never in it: a hosting platform's variables for the web service. */
export function platformOverrideFile(directory: string): string {
  return `${directory}.platform.yml`;
}

/**
 * COMPOSE_FILE for a shop on a hosting platform: its own compose.yml plus the
 * harness's override beside it. No file in the shop names the override, so the
 * agent's own `docker compose` merges it without being pointed at the codes.
 */
export function shopComposeEnv(directory: string): Record<string, string> {
  const override = platformOverrideFile(directory);
  return existsSync(override)
    ? { COMPOSE_FILE: [path.join(directory, "compose.yml"), override].join(path.delimiter) }
    : {};
}

/**
 * docker compose in `cwd`. The project name is the directory basename, so a
 * later `docker compose` from that same directory attaches to this stack.
 */
export function compose(
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  const label = path.basename(cwd);
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", ...args], {
      cwd,
      env: { ...process.env, ...shopComposeEnv(cwd) },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      process.stderr.write(`[${label}] ${chunk}`);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new InfraError(error.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = `${stderr}${stdout}`.trim();
      const tail = detail.split("\n").slice(-30).join("\n");
      reject(new InfraError(tail === "" ? `docker compose exited ${code}` : tail));
    });
  });
}

export async function dockerAvailable(): Promise<void> {
  await compose(process.cwd(), ["version"], 15_000);
}
