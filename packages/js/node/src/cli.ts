import {
  formatOpenReceiveInvalidNwcMessage,
  NwcUriParseError,
  parseNwcUri,
} from "@openreceive/core";
import { readLscConnectionsFromEnvironment } from "./lsc-uri.ts";
import {
  runScaffoldPayments,
  SCAFFOLD_PAYMENTS_HELP,
} from "./scaffold/index.ts";
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
  readonly stdin?: NodeJS.ReadableStream;
  readonly isTTY?: boolean;
  readonly prompt?: (question: string) => Promise<string>;
}

const HELP = `
Usage: openreceive <command> [options]

Commands:
  doctor              Validate storage-free server configuration.
  debug-report        Print a redacted local support report.
  scaffold payments   Add host-owned openreceive_payments scaffolding for your ORM.

Options:
  -h, --help           Show this help.
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
      if (args.length > 0) throw new Error(`Unexpected option: ${args[0]}`);
      return runDiagnostics({ command, env, cwd, stdout });
    }
    if (command === "scaffold") {
      const [target = "help", ...scaffoldArgs] = args;
      if (target === "help" || target === "--help" || target === "-h") {
        stdout.write(`${SCAFFOLD_PAYMENTS_HELP}\n`);
        return 0;
      }
      if (target !== "payments") {
        throw new Error(
          `Unknown scaffold target: ${target}. Only "payments" is supported.`,
        );
      }
      return await runScaffoldPayments({
        argv: scaffoldArgs,
        cwd,
        stdout,
        stderr,
        stdin: options.stdin,
        isTTY: options.isTTY,
        prompt: options.prompt,
      });
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
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdout: OpenReceiveCliIo;
}): number {
  const nwc = input.env.NWC_URI?.trim();
  let nwcError: unknown;
  try {
    if (nwc) parseNwcUri(nwc);
  } catch (error) {
    nwcError =
      error instanceof NwcUriParseError
        ? new Error(formatOpenReceiveInvalidNwcMessage({ reason: error.description }))
        : error;
  }
  let lscConnections = 0;
  let lscError: unknown;
  try {
    lscConnections = readLscConnectionsFromEnvironment(input.env).length;
  } catch (error) {
    lscError = error;
  }
  const lines = [
    `OpenReceive ${input.command}`,
    `node: ${process.version}`,
    `cwd: ${input.cwd}`,
    "storage: none (by design)",
    `NWC_URI: ${nwcError === undefined ? (nwc ? "present-redacted" : "missing") : safeErrorMessage(nwcError)}`,
    `LSC_URI connections: ${lscError === undefined ? lscConnections : safeErrorMessage(lscError)}`,
  ];
  input.stdout.write(`${lines.join("\n")}\n`);
  return nwcError !== undefined || !nwc || lscError !== undefined ? 1 : 0;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message);
  if (typeof error === "string") return redactSecrets(error);
  return "OpenReceive command failed.";
}

export {
  finalizeScaffoldOptions,
  parseScaffoldPaymentsArgv,
  renderScaffoldPaymentsFiles,
  runScaffoldPayments,
} from "./scaffold/index.ts";
