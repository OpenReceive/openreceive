// `npm run test:model -- --seed <n> --runs <n>`: fresh random attempt-state-machine
// sequences through every engine, or `--file <path>` to replay a vector file.
//
//   --seed <n>       generator seed (default: time-based, printed so a run can be repeated)
//   --runs <n>       number of sequences (default 100)
//   --max-steps <n>  longest generated sequence (default 20)
//   --engines a,b    subset of js,python,php,ruby (default all; an engine whose
//                    toolchain is missing is reported as skipped)
//   --file <path>    replay this vector file instead of generating
//
// On a failure the sequence is shrunk (delta debugging against the failing
// engine, re-deriving each candidate's expected states from the model) and the
// minimal sequence is printed.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSequence } from "../../tests/helpers/attempt-state-machine-runner.mjs";
import { generateSequences } from "./generate.mjs";
import { InvalidSequence, simulate } from "./model.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALL_ENGINES = ["js", "python", "php", "ruby"];
const RUBY_DOCKER_IMAGE = "ruby:3.4";

const OP_FIELDS = new Set([
  "op",
  "ref",
  "rail",
  "id",
  "expires_in",
  "deposit_in",
  "state",
  "settled_at",
  "by",
  "kind",
  "finality",
  "mode",
  "fail_fulfillment",
  "paid_at",
  "status",
]);

function stripDerived(step) {
  const op = {};
  for (const [key, value] of Object.entries(step)) {
    if (OP_FIELDS.has(key)) op[key] = value;
  }
  return op;
}

function parseArgs(argv) {
  const options = {
    runs: 100,
    maxSteps: 20,
    engines: ALL_ENGINES,
    seed: undefined,
    file: undefined,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--seed") options.seed = Number(value);
    else if (flag === "--runs") options.runs = Number(value);
    else if (flag === "--max-steps") options.maxSteps = Number(value);
    else if (flag === "--engines") options.engines = value.split(",");
    else if (flag === "--file") options.file = value;
    else throw new Error(`unknown flag ${flag}`);
  }
  options.seed ??= Date.now() % 2_147_483_647;
  return options;
}

/** Runs one engine over a file of sequences; returns its per-sequence results. */
function runProcess(engine, sequencesFile) {
  const report = (command, args, cwd, extraEnv = {}) => {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      env: { ...process.env, ...extraEnv },
    });
    if (result.status !== 0) {
      throw new Error(
        `${engine} runner failed (exit ${result.status}):\n${result.stderr}\n${result.stdout}`,
      );
    }
    const start = result.stdout.lastIndexOf('\n[{"name"');
    return JSON.parse(start === -1 ? result.stdout : result.stdout.slice(start + 1));
  };
  if (engine === "python") {
    return report(
      "uv",
      [
        "run",
        "--frozen",
        "--quiet",
        "python",
        "-m",
        "tests.vectors.attempt_state_machine_runner",
        sequencesFile,
      ],
      path.join(ROOT, "packages/python/openreceive"),
    );
  }
  if (engine === "php") {
    return report(
      "php",
      ["packages/php/openreceive/tests/Support/attempt-state-machine.php", sequencesFile],
      ROOT,
    );
  }
  if (engine === "ruby") return runRuby(sequencesFile, report);
  throw new Error(`no runner for ${engine}`);
}

function hasRubyGems() {
  const probe = spawnSync("ruby", ["-e", 'require "active_record"; require "sqlite3"'], {
    encoding: "utf8",
  });
  return probe.status === 0;
}

const RUBY_INCLUDES = [
  "-Ipackages/ruby/openreceive/lib",
  "-Ipackages/ruby/openreceive-server/lib",
  "-Ipackages/ruby/openreceive-rails/lib",
];
const RUBY_CLI = "packages/ruby/openreceive-rails/test/attempt_state_machine_cli.rb";

function runRuby(sequencesFile, report) {
  if (rubyMode === "local") {
    return report("ruby", [...RUBY_INCLUDES, RUBY_CLI, sequencesFile], ROOT);
  }
  // The host has no Ruby gems: run the suite the way CI does, in a ruby:3.4 container.
  const bundleCache = path.join(ROOT, ".cache/attempt-model/bundle-3.4");
  mkdirSync(bundleCache, { recursive: true });
  const script = `bundle install --jobs 8 --quiet && bundle exec ruby ${RUBY_INCLUDES.join(" ")} ${RUBY_CLI} /sequences/${path.basename(sequencesFile)}`;
  return report(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "-e",
      "HOME=/tmp",
      "-e",
      "BUNDLE_PATH=/bundle",
      "-e",
      "BUNDLE_FROZEN=true",
      "-e",
      "NWC_URI=",
      "-v",
      `${ROOT}:/app`,
      "-v",
      `${bundleCache}:/bundle`,
      "-v",
      `${path.dirname(sequencesFile)}:/sequences`,
      "-w",
      "/app",
      RUBY_DOCKER_IMAGE,
      "bash",
      "-c",
      script,
    ],
    ROOT,
  );
}

let rubyMode;

function toolAvailable(command, args = ["--version"]) {
  return spawnSync(command, args, { encoding: "utf8" }).status === 0;
}

/** Which engines can actually run here; the rest are reported as skipped. */
function availability(engines) {
  const skipped = {};
  const available = [];
  for (const engine of engines) {
    if (engine === "python" && !toolAvailable("uv")) {
      skipped.python = "uv is not installed";
    } else if (engine === "php" && !toolAvailable("php")) {
      skipped.php = "php is not installed";
    } else if (
      engine === "php" &&
      !existsSync(path.join(ROOT, "packages/php/openreceive/vendor/autoload.php"))
    ) {
      skipped.php = "run composer install in packages/php/openreceive first";
    } else if (engine === "ruby") {
      if (toolAvailable("ruby") && hasRubyGems()) {
        rubyMode = "local";
      } else if (toolAvailable("docker")) {
        rubyMode = "docker";
      } else {
        skipped.ruby = "ruby with activerecord and sqlite3, or docker, is required";
        continue;
      }
      available.push(engine);
    } else {
      available.push(engine);
    }
  }
  return { available, skipped };
}

function writeSequences(directory, sequences) {
  const file = path.join(
    directory,
    `sequences-${Date.now()}-${Math.floor(Math.random() * 1e9)}.json`,
  );
  writeFileSync(file, JSON.stringify({ sequences }));
  return file;
}

async function runEngine(engine, sequences, directory) {
  if (engine === "js") {
    const results = [];
    for (const sequence of sequences) results.push(await runSequence(sequence));
    return results;
  }
  return runProcess(engine, writeSequences(directory, sequences));
}

function asSequence(name, ops) {
  return { name, steps: simulate(ops) };
}

/**
 * Delta debugging over the operation list: try dropping chunks (halving their
 * size) and keep any candidate the engine still fails on. Each candidate's
 * expected states are re-derived by the model; a candidate the model calls
 * meaningless is skipped.
 */
async function shrink(engine, failingOps, directory) {
  let current = failingOps;
  let chunk = Math.max(1, Math.floor(current.length / 2));
  while (chunk >= 1 && current.length > 1) {
    let progressed = false;
    const candidates = [];
    for (let start = 0; start < current.length; start += chunk) {
      const candidate = [...current.slice(0, start), ...current.slice(start + chunk)];
      try {
        candidates.push(asSequence(`candidate-${candidates.length}`, candidate));
      } catch (error) {
        if (!(error instanceof InvalidSequence)) throw error;
      }
    }
    if (candidates.length > 0) {
      const results = await runEngine(engine, candidates, directory);
      const index = results.findIndex((result) => !result.ok);
      if (index !== -1) {
        current = candidates[index].steps.map(stripDerived);
        progressed = true;
      }
    }
    if (!progressed) {
      if (chunk === 1) break;
      chunk = Math.max(1, Math.floor(chunk / 2));
    }
  }
  return current;
}

function formatStep(step, index) {
  const { rows, fulfilled, outcome, reason, t, ...op } = step;
  const parts = [`  ${String(index).padStart(2)}  t=${t}  ${JSON.stringify(op)}`];
  if (outcome !== undefined) parts.push(`      -> outcome: ${outcome}`);
  if (reason !== undefined) parts.push(`      -> reason: ${reason}`);
  if (rows !== undefined) parts.push(`      -> rows: ${JSON.stringify(rows)}`);
  if (fulfilled !== undefined) parts.push(`      -> fulfilled: ${JSON.stringify(fulfilled)}`);
  return parts.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const directory = mkdtempSync(path.join(tmpdir(), "attempt-model-"));
  const sequences =
    options.file !== undefined
      ? JSON.parse(readFileSync(options.file, "utf8")).sequences
      : generateSequences({ seed: options.seed, count: options.runs, maxSteps: options.maxSteps });
  const steps = sequences.reduce((sum, sequence) => sum + sequence.steps.length, 0);
  console.log(
    options.file !== undefined
      ? `replaying ${options.file}: ${sequences.length} sequences, ${steps} steps`
      : `seed ${options.seed}: ${sequences.length} sequences, ${steps} steps`,
  );
  const { available, skipped } = availability(options.engines);
  for (const [engine, reason] of Object.entries(skipped)) {
    console.log(`${engine.padEnd(7)} skipped: ${reason}`);
  }
  let failed = false;
  for (const engine of available) {
    const results = await runEngine(engine, sequences, directory);
    const failures = results.filter((result) => !result.ok);
    console.log(`${engine.padEnd(7)} ${results.length - failures.length}/${results.length} passed`);
    if (failures.length === 0) continue;
    failed = true;
    for (const failure of failures.slice(0, 3)) {
      console.log(`\n${engine} failed ${failure.name} at step ${failure.step} (${failure.kind}):`);
      console.log(`  ${failure.message.split("\n")[0]}`);
    }
    const first = failures[0];
    const originalOps = sequences
      .find((sequence) => sequence.name === first.name)
      .steps.map(stripDerived);
    const minimal = await shrink(engine, originalOps, directory);
    const minimalSteps = simulate(minimal);
    const verdict = await runEngine(engine, [asSequence(first.name, minimal)], directory);
    console.log(`\nminimal failing sequence for ${engine} (${minimal.length} steps):`);
    for (const [index, step] of minimalSteps.entries()) console.log(formatStep(step, index));
    if (verdict[0].ok) {
      console.log("(the shrunk sequence passed on re-run: the failure is flaky)");
    } else {
      console.log(
        `failure: step ${verdict[0].step} (${verdict[0].kind}): ${verdict[0].message.split("\n")[0]}`,
      );
      console.log(`steps as JSON: ${JSON.stringify(minimal)}`);
    }
  }
  rmSync(directory, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}

await main();
