import { readOpenReceiveConfigFile, type OpenReceiveFileConfig } from "./config.ts";
import { redactSecrets } from "./service/logging.ts";

export interface OpenReceiveCliIo {
  write(message: string): void;
}

export interface OpenReceiveCliOptions {
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly stdout?: OpenReceiveCliIo;
  readonly stderr?: OpenReceiveCliIo;
}

const HELP = `
Usage: openreceive <command> [options]

Commands:
  doctor              Validate storage-free server configuration.
  debug-report        Print a redacted local support report.

Options:
  --config <path>      YAML config file. Defaults to openreceive.yml.
`.trim();

export async function runOpenReceiveCli(options: OpenReceiveCliOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const [command = "help", ...args] = options.argv;
  try {
    if (["help", "--help", "-h"].includes(command)) {
      stdout.write(`${HELP}\n`);
      return 0;
    }
    if (command === "doctor" || command === "debug-report") {
      return runDiagnostics({ command, args, env, cwd, stdout });
    }
    stderr.write(`Unknown OpenReceive command: ${command}\n\n${HELP}\n`);
    return 1;
  } catch (error) {
    stderr.write(`${safeErrorMessage(error)}\n`);
    return 1;
  }
}

function runDiagnostics(input: {
  readonly command: "doctor" | "debug-report";
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdout: OpenReceiveCliIo;
}): number {
  let config: OpenReceiveFileConfig | undefined;
  let configError: unknown;
  try {
    config = readOpenReceiveConfigFile({
      cwd: input.cwd,
      configPath: readFlag(input.args, "--config"),
    });
  } catch (error) {
    configError = error;
  }
  const nwc = configError === undefined ? config?.nwc : undefined;
  const lines = [
    `OpenReceive ${input.command}`,
    `node: ${process.version}`,
    `cwd: ${input.cwd}`,
    "storage: none (by design)",
    `nwc: ${nwc === undefined || nwc.trim() === "" ? "missing" : "present-redacted"}`,
    `config: ${configError === undefined ? (config === undefined ? "missing" : "loaded") : safeErrorMessage(configError)}`,
    `swap_providers: ${config?.swap?.providers?.length ?? 0}`,
  ];
  input.stdout.write(`${lines.join("\n")}\n`);
  return configError !== undefined || nwc === undefined || nwc.trim() === "" ? 1 : 0;
}

function readFlag(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message);
  if (typeof error === "string") return redactSecrets(error);
  return "OpenReceive command failed.";
}
