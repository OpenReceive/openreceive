import { spawn } from "node:child_process";
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
    const child = spawn("docker", ["compose", ...args], { cwd });
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
