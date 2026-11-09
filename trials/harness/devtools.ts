import { execFile } from "node:child_process";
import { createDecipheriv, createECDH, createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { clientPrefix } from "./chaos.ts";
import { compose, InfraError } from "./docker.ts";
import { codesInShopFiles, debugPageChecks } from "./leaks.ts";
import { type Answer, check, Visitor } from "./live.ts";
import type { Check, Platform } from "./types.ts";
import type { TrialWallet } from "./wallet.ts";

// What a developer's own tools do to a shop an agent built, after the agent is
// gone and without spending a token: the framework's debug page, a production
// build with no wallet codes around, the shop's own test suite with no
// network, a dev server's hot reload, and several workers at once. Every step
// runs inside the shop's own container and leaves the shop as it found it;
// a stack a check cannot apply to is left out, not passed.

const execFileAsync = promisify(execFile);
const trialsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const APP_DIR = "/app";
const SCRATCH = "/tmp/openreceive-devtools";
const DEV_PORT = 39001;
const WORKERS_PORT = 39002;
const BUILD_TIMEOUT_MS = 12 * 60_000;
const TEST_TIMEOUT_MS = 8 * 60_000;
const DEV_START_TIMEOUT_MS = 4 * 60_000;
const SAVES = 20;
const SAVE_SETTLE_MS = 1_200;
const WORKER_COUNT = 4;
const CONCURRENCY = 8;
/** The durable gate's floor between real scans, and the slack a timestamp at the relay needs. */
const GATE_INTERVAL_S = 3;
const GATE_SLACK_S = 0.6;
const SOCKET_SLACK = 3;

const CODE_ENV = /^(?:NWC_URI|LSC_URI_[A-Z0-9_]+)$/;

export interface DevtoolsTarget {
  readonly directory: string;
  readonly platform: Platform;
  readonly baseUrl: string;
  readonly wallet: TrialWallet;
  readonly log?: (line: string) => void;
}

interface BuildStep {
  /** Run in a scratch copy of the app, with no wallet code anywhere it could read. */
  readonly script: string;
}

interface OwnTests {
  /** Run with no network, from the app directory. */
  readonly command: string;
  /** Test files and directories, each copied in from the shop (or, on a shop kept before the fixture had them, the fixture). */
  readonly paths: readonly string[];
  /** Set for the test run only, over the shop's own environment. */
  readonly env?: Readonly<Record<string, string>>;
}

interface HotReload {
  /** Starts the dev server on $PORT, from a scratch copy of the app. */
  readonly start: string;
  /** Files one save appends to, first one that exists. */
  readonly saves: readonly string[];
  /** A comment line in that file's language. */
  readonly comment: string;
  /** Matches one reload in the dev server's log. */
  readonly reloaded?: RegExp;
  /** Written into the scratch copy before the server starts. */
  readonly setup?: string;
}

interface Workers {
  /** Starts the workers on $PORT, from the app directory. */
  readonly start: string;
  /** Matches a worker's command line in /proc. */
  readonly process: RegExp;
}

interface StackTools {
  readonly build?: BuildStep;
  readonly tests?: OwnTests;
  readonly hotReload?: HotReload;
  readonly workers?: Workers;
  /** The fixture's orders table, as `bin/order-status` reads it. */
  readonly ordersTable?: string;
  /** How this stack runs SQL against /data/shop.sqlite. */
  readonly sqlite?: "python" | "node" | "ruby" | "php";
}

const NPM_BUILD: BuildStep = { script: "npm run build" };
const NODE_DEV_SCRATCH = "rm -rf .next .nuxt .svelte-kit";

const NODE_CLUSTER = (entry: string): string => `
cat > /tmp/openreceive-devtools-cluster.mjs <<'CLUSTER'
import cluster from "node:cluster";
if (cluster.isPrimary) {
  for (let worker = 0; worker < ${WORKER_COUNT}; worker += 1) cluster.fork();
} else {
  process.chdir("${APP_DIR}");
  await import("${APP_DIR}/${entry}");
}
CLUSTER
exec node /tmp/openreceive-devtools-cluster.mjs`;

const STACKS: Readonly<Record<string, StackTools>> = {
  node: {
    tests: { command: "node --test", paths: ["test"] },
    hotReload: {
      start: "node --watch server.js",
      saves: ["server.js"],
      comment: "//",
      reloaded: /Restarting/,
    },
    workers: { start: NODE_CLUSTER("server.js"), process: /openreceive-devtools-cluster/ },
    sqlite: "node",
  },
  fastify: {
    tests: { command: "node --test", paths: ["test"] },
    hotReload: {
      start: "node --watch server.js",
      saves: ["server.js"],
      comment: "//",
      reloaded: /Restarting/,
    },
    workers: { start: NODE_CLUSTER("server.js"), process: /openreceive-devtools-cluster/ },
    sqlite: "node",
  },
  next: {
    build: NPM_BUILD,
    tests: { command: "node --test", paths: ["test"] },
    hotReload: {
      setup: NODE_DEV_SCRATCH,
      start: "./node_modules/.bin/next dev -H 0.0.0.0 -p $PORT",
      saves: ["lib/shop.js", "src/lib/shop.js", "app/page.js", "src/app/page.js"],
      comment: "//",
      reloaded: /Compil|Fast Refresh|Rebuilt|✓/,
    },
  },
  nuxt: {
    build: NPM_BUILD,
    hotReload: {
      setup: NODE_DEV_SCRATCH,
      start: "./node_modules/.bin/nuxt dev --host 0.0.0.0 --port $PORT",
      saves: ["server/utils/shop.ts", "server/utils/db.ts", "app/app.vue"],
      comment: "//",
      reloaded: /HMR|hmr|reload|Rebuil/i,
    },
  },
  sveltekit: {
    build: NPM_BUILD,
    hotReload: {
      setup: NODE_DEV_SCRATCH,
      start: "./node_modules/.bin/vite dev --host 0.0.0.0 --port $PORT",
      saves: ["src/lib/server/shop.ts", "src/hooks.server.ts", "src/routes/+page.svelte"],
      comment: "//",
      reloaded: /hmr|reload|page reload/i,
    },
  },
  astro: { build: NPM_BUILD },
  "react-router": { build: NPM_BUILD },
  "tanstack-start": { build: NPM_BUILD },
  nestjs: { build: NPM_BUILD },
  django: {
    build: { script: "python manage.py check" },
    tests: { command: "python manage.py test --noinput", paths: ["shop/tests.py"] },
    hotReload: {
      start: "python manage.py runserver 0.0.0.0:$PORT",
      saves: ["shop/views.py", "shop/urls.py", "widgetshop/settings.py"],
      comment: "#",
      // Its reload line goes through DEBUG-only logging; the system-check banner always prints.
      reloaded: /changed, reloading|Performing system checks/,
    },
    workers: {
      start: `pip install --quiet --target /tmp/openreceive-devtools-gunicorn gunicorn && PYTHONPATH=/tmp/openreceive-devtools-gunicorn exec python -m gunicorn --workers ${WORKER_COUNT} --threads 4 --bind 0.0.0.0:$PORT widgetshop.wsgi:application`,
      process: /gunicorn/,
    },
    ordersTable: "shop_order",
    sqlite: "python",
  },
  flask: {
    tests: { command: "python -m unittest test_shop", paths: ["test_shop.py"] },
    workers: {
      start: `exec gunicorn --workers ${WORKER_COUNT} --threads 8 --bind 0.0.0.0:$PORT app:app`,
      process: /gunicorn/,
    },
    sqlite: "python",
  },
  fastapi: {
    tests: { command: "python -m unittest test_shop", paths: ["test_shop.py"] },
    workers: {
      start: `exec uvicorn main:app --workers ${WORKER_COUNT} --host 0.0.0.0 --port $PORT`,
      process: /uvicorn|multiprocessing/,
    },
    sqlite: "python",
  },
  rails: {
    build: {
      // A shop without the asset pipeline has no build to run (exit 77: left out).
      script:
        'if bundle exec rake -T 2>/dev/null | grep -q "assets:precompile"; then bundle exec rake assets:precompile; else exit 77; fi',
    },
    tests: {
      command: "bundle exec ruby -Itest test/shop_test.rb",
      paths: ["test/shop_test.rb"],
    },
    hotReload: {
      setup: `mkdir -p config/environments
cat > config/environments/development.rb <<'ENVFILE'
Rails.application.configure do
  config.enable_reloading = true
  config.eager_load = false
  config.consider_all_requests_local = true
  config.hosts.clear
end
ENVFILE`,
      start: `RAILS_ENV=development DATABASE_URL="\${DATABASE_URL:-sqlite3:/data/shop.sqlite}" bundle exec rails server -b 0.0.0.0 -p $PORT`,
      saves: ["app/controllers/orders_controller.rb"],
      comment: "#",
    },
    workers: {
      start: `exec bundle exec puma -w ${WORKER_COUNT} -t 1:4 -b tcp://0.0.0.0:$PORT config.ru`,
      process: /puma/,
    },
    sqlite: "ruby",
  },
  laravel: {
    build: {
      script: "php artisan config:cache && php artisan route:cache && php artisan view:cache",
    },
    tests: {
      command: "vendor/bin/phpunit --no-progress",
      paths: ["tests"],
      env: { APP_ENV: "testing" },
    },
    workers: {
      start: `PHP_CLI_SERVER_WORKERS=${WORKER_COUNT} exec php artisan serve --host=0.0.0.0 --port=$PORT`,
      process: /php|artisan/,
    },
    sqlite: "php",
  },
  php: {
    workers: {
      start: `PHP_CLI_SERVER_WORKERS=${WORKER_COUNT} exec php -S 0.0.0.0:$PORT -t public public/router.php`,
      process: /php -S|php/,
    },
    sqlite: "php",
  },
};

/** The tools that apply to a platform: named by its fixture, so Vercel's or Replit's own stacks are not assumed. */
function stackTools(platform: Platform): StackTools | undefined {
  if (platform.host !== undefined) return undefined;
  return Object.hasOwn(STACKS, platform.slug) ? STACKS[platform.slug] : undefined;
}

function serviceOf(platform: Platform): string {
  return platform.service ?? "web";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs a shell script in the shop's service container; never throws for the script's own exit. */
async function shell(
  directory: string,
  service: string,
  script: string,
  timeoutMs: number,
): Promise<{ code: number; output: string }> {
  // A subshell, so a script's own `exit` still reaches the status line.
  const wrapped = `( ${script}
); echo "__OPENRECEIVE_DEVTOOLS_EXIT__ $?"`;
  const result = await compose(directory, ["exec", "-T", service, "sh", "-c", wrapped], timeoutMs, {
    quiet: true,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const match = output.match(/__OPENRECEIVE_DEVTOOLS_EXIT__ (\d+)/);
  return {
    code: match === null ? 1 : Number(match[1]),
    output: output.replace(/__OPENRECEIVE_DEVTOOLS_EXIT__ \d+\n?/g, ""),
  };
}

function tail(text: string, lines = 25): string {
  return text.trim().split("\n").slice(-lines).join("\n").slice(-2_500);
}

/** A scratch copy of the app with the codes taken out of every env file and the environment. */
function noCodesPreamble(scratch: string): string {
  return `set -e
SCRATCH=${scratch}
rm -rf "$SCRATCH"
cp -a ${APP_DIR} "$SCRATCH"
cd "$SCRATCH"
for envfile in .env .env.local .env.production .env.development; do
  [ -f "$envfile" ] || continue
  sed -i -E '/^[[:space:]]*(export[[:space:]]+)?(NWC_URI|LSC_URI_[A-Z0-9_]*)[[:space:]]*=/d' "$envfile"
done
for name in $(env | sed -n 's/^\\(NWC_URI[A-Z0-9_]*\\|LSC_URI_[A-Z0-9_]*\\)=.*/\\1/p'); do unset "$name"; done
`;
}

async function buildCheck(target: DevtoolsTarget, tools: StackTools): Promise<Check[]> {
  if (tools.build === undefined) return [];
  const service = serviceOf(target.platform);
  const scratch = `${SCRATCH}-build`;
  const summary =
    "A production build with no wallet codes in the environment or in any env file succeeds, as a merchant's CI builds it.";
  try {
    const result = await shell(
      target.directory,
      service,
      `${noCodesPreamble(scratch)}
rm -rf .next
${tools.build.script}`,
      BUILD_TIMEOUT_MS,
    );
    if (result.code === 77) return [];
    return [check("build_without_codes", result.code === 0, summary, tail(result.output))];
  } catch (error) {
    return [check("build_without_codes", false, summary, String(error).slice(0, 800))];
  } finally {
    await shell(target.directory, service, `rm -rf ${scratch}`, 60_000).catch(() => {});
  }
}

async function dockerJson(args: readonly string[], timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync("docker", [...args], {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

async function containerOf(directory: string, service: string): Promise<string> {
  const { stdout } = await compose(directory, ["ps", "-q", service], 30_000, { quiet: true });
  const id = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (id === undefined) throw new InfraError(`${service} has no running container.`);
  return id;
}

/** The address a shop's container answers on, for the harness on the host. */
async function containerAddress(container: string): Promise<string> {
  const ip = await dockerJson([
    "inspect",
    "--format",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
    container,
  ]);
  const first = ip.split(/\s+/).find((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value));
  if (first === undefined) throw new InfraError(`${container} has no address on a Docker network.`);
  return first;
}

/**
 * The merchant's tests as they were before the agent came: a test the agent
 * added beside them may reach for the wallet, and is not what this check asks.
 */
function testsPath(target: DevtoolsTarget, relative: string): string {
  const inFixture = path.join(trialsRoot, "platforms", target.platform.slug, "fixture", relative);
  if (existsSync(inFixture)) return inFixture;
  const inShop = path.join(target.directory, relative);
  if (!existsSync(inShop)) {
    throw new InfraError(`${relative} is in neither the shop nor its fixture.`);
  }
  return inShop;
}

/** `docker run` the shop's own image with no network, from its environment, with or without the codes. */
async function runOwnTests(
  target: DevtoolsTarget,
  tools: StackTools,
  withCodes: boolean,
): Promise<{ ok: boolean; output: string }> {
  const service = serviceOf(target.platform);
  const container = await containerOf(target.directory, service);
  const image = await dockerJson(["inspect", "--format", "{{.Image}}", container]);
  const envJson = await dockerJson(["inspect", "--format", "{{json .Config.Env}}", container]);
  const envLines = (JSON.parse(envJson) as string[])
    .filter((line) => !line.includes("\n"))
    .filter((line) => withCodes || !CODE_ENV.test(line.split("=", 1)[0] ?? ""));
  const envFile = `${target.directory}.devtools.env`;
  await writeFile(envFile, `${envLines.join("\n")}\n`, { mode: 0o600 });
  const mounts = (tools.tests as OwnTests).paths.flatMap((relative) => [
    "-v",
    `${testsPath(target, relative)}:${APP_DIR}/${relative}:ro`,
  ]);
  const removeCodes = withCodes ? "" : "rm -f .env .env.local .env.production .env.development; ";
  try {
    const { stdout, stderr } = await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--env-file",
        envFile,
        ...Object.entries((tools.tests as OwnTests).env ?? {}).flatMap(([name, value]) => [
          "-e",
          `${name}=${value}`,
        ]),
        "-w",
        APP_DIR,
        ...mounts,
        image,
        "sh",
        "-c",
        `${removeCodes}${(tools.tests as OwnTests).command}`,
      ],
      { timeout: TEST_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
    );
    return { ok: true, output: `${stdout}\n${stderr}` };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: `${failed.stdout ?? ""}\n${failed.stderr ?? ""}\n${failed.message ?? ""}`.trim(),
    };
  } finally {
    await rm(envFile, { force: true }).catch(() => undefined);
  }
}

async function ownTestChecks(target: DevtoolsTarget, tools: StackTools): Promise<Check[]> {
  if (tools.tests === undefined) return [];
  const checks: Check[] = [];
  try {
    const offline = await runOwnTests(target, tools, true);
    checks.push(
      check(
        "own_tests_offline",
        offline.ok,
        "The shop's own test suite still passes with no network, after the agent's change.",
        tail(offline.output),
      ),
    );
  } catch (error) {
    checks.push(check("own_tests_offline", false, "The shop's own test suite ran.", String(error)));
  }
  try {
    const noCodes = await runOwnTests(target, tools, false);
    checks.push({
      ...check(
        "own_tests_no_codes",
        noCodes.ok,
        "With no wallet code set, as on a merchant's CI, the shop's own tests still pass (a shop that refuses to boot without a code fails here).",
        tail(noCodes.output),
      ),
      severity: "polish",
    });
  } catch (error) {
    checks.push({
      ...check("own_tests_no_codes", false, "The shop's own test suite ran.", String(error)),
      severity: "polish",
    });
  }
  return checks;
}

/** Established connections to `ip`:443 in a /proc/net/tcp dump, the sockets a shop holds toward the relay. */
export function relaySockets(procNetTcp: string, ip: string): number {
  const wanted = ip
    .split(".")
    .map((part) => Number(part).toString(16).padStart(2, "0"))
    .reverse()
    .join("")
    .toUpperCase();
  let count = 0;
  for (const line of procNetTcp.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const remote = fields[2] ?? "";
    const state = fields[3] ?? "";
    if (state !== "01" || !remote.endsWith(":01BB")) continue;
    const address = remote.slice(0, -5).toUpperCase();
    // A v6 line carries the v4 address as its last eight hex digits.
    if (address === wanted || address.endsWith(wanted)) count += 1;
  }
  return count;
}

async function countRelaySockets(target: DevtoolsTarget, service: string): Promise<number> {
  const { output } = await shell(
    target.directory,
    service,
    "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null",
    15_000,
  );
  return relaySockets(output, target.wallet.interceptor.ip);
}

/** Signals every process of one session, `setsid`'s group: dash's `kill` takes no negative pid. */
function signalSession(signal: string): string {
  return `for entry in /proc/[0-9]*; do
  stat=$(cat "$entry/stat" 2>/dev/null) || continue
  session=$(printf '%s\\n' "\${stat##*) }" | cut -d' ' -f4)
  [ "$session" = "$group" ] && kill -s ${signal} "\${entry##*/}" 2>/dev/null
done`;
}

async function stopScratchProcess(
  directory: string,
  service: string,
  pidFile: string,
): Promise<void> {
  await shell(
    directory,
    service,
    `[ -f ${pidFile} ] || exit 0
group=$(cat ${pidFile})
${signalSession("TERM")}
for wait in 1 2 3 4 5 6 7 8 9 10; do
  [ -d /proc/"$group" ] || break
  sleep 0.5
done
${signalSession("KILL")}
rm -f ${pidFile}`,
    30_000,
  ).catch(() => {});
}

/** Starts a long-running server in its own session; returns once `sh` has backgrounded it, or a reason it could not start. */
async function startScratchProcess(
  directory: string,
  service: string,
  options: {
    readonly cwd: string;
    readonly pidFile: string;
    readonly logFile: string;
    readonly start: string;
    readonly port: number;
  },
): Promise<string | undefined> {
  const { cwd, pidFile, logFile, start, port } = options;
  await stopScratchProcess(directory, service, pidFile);
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  const started = await shell(
    directory,
    service,
    `if cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | grep -Eq '^ *[0-9]+: [0-9A-F]+:${hex} [0-9A-F]+:[0-9A-F]+ 0A '; then echo PORT_IN_USE; exit 0; fi
cd ${cwd}
rm -f ${pidFile}
setsid sh -c 'echo $$ > ${pidFile}; ${start.replaceAll("'", "'\\''")}' >${logFile} 2>&1 &
sleep 1`,
    30_000,
  );
  return started.output.includes("PORT_IN_USE")
    ? `port ${port} is already in use inside the container`
    : undefined;
}

async function waitForAnswer(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await fetch(url, { signal: AbortSignal.timeout(20_000) })
      .then((response) => response.status)
      .catch(() => 0);
    if (status > 0 && status < 500) return true;
    await sleep(1_000);
  }
  return false;
}

interface SaveRecord {
  readonly sockets: number;
  readonly status: number;
}

async function hotReloadCheck(target: DevtoolsTarget, tools: StackTools): Promise<Check[]> {
  const reload = tools.hotReload;
  if (reload === undefined) return [];
  const service = serviceOf(target.platform);
  const summary = `After ${SAVES} saves under the stack's dev server, the shop holds no more relay connections than after the first save.`;
  const scratch = `${SCRATCH}-hot`;
  const pidFile = `${SCRATCH}-hot.pid`;
  const logFile = `${SCRATCH}-hot.log`;
  const log = target.log ?? (() => {});
  try {
    const container = await containerOf(target.directory, service);
    const address = await containerAddress(container);
    const dev = `http://${address}:${DEV_PORT}`;
    const prepared = await shell(
      target.directory,
      service,
      `set -e
rm -rf ${scratch}
cp -a ${APP_DIR} ${scratch}
cd ${scratch}
${reload.setup ?? ""}
for file in ${reload.saves.join(" ")}; do
  if [ -f "$file" ]; then echo "SAVE_FILE=$file"; break; fi
done`,
      5 * 60_000,
    );
    const saved = prepared.output.match(/SAVE_FILE=(\S+)/)?.[1];
    if (prepared.code !== 0 || saved === undefined) {
      return [
        check(
          "hot_reload_no_socket_leak",
          false,
          summary,
          `no file to save: ${tail(prepared.output)}`,
        ),
      ];
    }
    const baseline = await countRelaySockets(target, service);
    log(`hot reload: dev server on ${dev}`);
    const refused = await startScratchProcess(target.directory, service, {
      cwd: scratch,
      pidFile,
      logFile,
      port: DEV_PORT,
      start: `PORT=${DEV_PORT} exec sh -c '${reload.start.replaceAll("'", "'\\''").replaceAll("$PORT", String(DEV_PORT))}'`,
    });
    if (refused !== undefined) return [check("hot_reload_no_socket_leak", false, summary, refused)];
    if (!(await waitForAnswer(`${dev}/health`, DEV_START_TIMEOUT_MS))) {
      return [
        check(
          "hot_reload_no_socket_leak",
          false,
          summary,
          `the dev server did not answer ${dev}/health\n${tail((await shell(target.directory, service, `tail -n 40 ${logFile}`, 15_000)).output)}`,
        ),
      ];
    }
    const buyer = new Visitor(dev, 3_000, 75_000);
    const records: SaveRecord[] = [];
    const answerStatus = async (): Promise<number> => {
      const order = await buyer.placeOrder();
      const answer = await buyer.createCheckoutOnce(order, buyer.orderPage(order));
      return answer.status;
    };
    // The first checkout opens the wallet connection the saves must not multiply.
    await answerStatus().catch(() => 0);
    await sleep(SAVE_SETTLE_MS);
    const first = await countRelaySockets(target, service);
    for (let save = 1; save <= SAVES; save += 1) {
      await shell(
        target.directory,
        service,
        `cd ${scratch} && printf '\\n${reload.comment} devtools save ${save}\\n' >> ${saved}`,
        15_000,
      );
      await sleep(SAVE_SETTLE_MS);
      await waitForAnswer(`${dev}/health`, 60_000);
      const status = await answerStatus().catch(() => 0);
      await sleep(SAVE_SETTLE_MS);
      records.push({ sockets: await countRelaySockets(target, service), status });
      log(`hot reload: save ${save}: ${records.at(-1)?.sockets} relay sockets, checkout ${status}`);
    }
    const devLog = (await shell(target.directory, service, `cat ${logFile}`, 15_000)).output;
    const reloads =
      reload.reloaded === undefined
        ? undefined
        : (devLog.match(new RegExp(reload.reloaded, "g")) ?? []).length;
    const last = records.at(-1)?.sockets ?? 0;
    const peak = Math.max(...records.map((record) => record.sockets), 0);
    const leaked = peak > first + SOCKET_SLACK;
    const reloadsSeen = reloads === undefined || reloads >= Math.floor(SAVES / 2);
    const series = records.map((record) => record.sockets).join(" ");
    const statuses = records.map((record) => record.status).join(" ");
    return [
      {
        ...check(
          "hot_reload_no_socket_leak",
          !leaked && reloadsSeen,
          summary,
          `${saved}: baseline ${baseline}, after first checkout ${first}, after each save ${series}, last ${last}, reloads in the dev log ${reloads ?? "(this stack logs none)"}; checkout statuses ${statuses}`,
        ),
        // Costs a developer sockets on a dev server, never a payer anything.
        severity: "polish",
      },
    ];
  } catch (error) {
    return [check("hot_reload_no_socket_leak", false, summary, String(error).slice(0, 800))];
  } finally {
    await stopScratchProcess(target.directory, service, pidFile);
    await shell(target.directory, service, `rm -rf ${scratch} ${pidFile} ${logFile}`, 60_000).catch(
      () => {},
    );
  }
}

/** The wallet pubkey and client secret of a `nostr+walletconnect://` code. */
export function parseNwcUri(uri: string): { walletPubkey: string; secret: string } | undefined {
  try {
    const parsed = new URL(uri);
    const secret = parsed.searchParams.get("secret");
    const walletPubkey = parsed.hostname;
    if (
      !/^[0-9a-f]{64}$/i.test(walletPubkey) ||
      secret === null ||
      !/^[0-9a-f]{64}$/i.test(secret)
    ) {
      return undefined;
    }
    return { walletPubkey: walletPubkey.toLowerCase(), secret: secret.toLowerCase() };
  } catch {
    return undefined;
  }
}

function sharedSecretX(secretHex: string, publicKeyHex: string): Buffer {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(secretHex, "hex"));
  return ecdh.computeSecret(Buffer.concat([Buffer.from([0x02]), Buffer.from(publicKeyHex, "hex")]));
}

/** NIP-44 v2 (HKDF-derived ChaCha20) or NIP-04 (AES-CBC), by the content's own shape. */
function decryptNip47Content(content: string, secretHex: string, walletPubkeyHex: string): string {
  const shared = sharedSecretX(secretHex, walletPubkeyHex);
  if (content.includes("?iv=")) {
    const [cipher, ivPart] = content.split("?iv=") as [string, string];
    const decipher = createDecipheriv("aes-256-cbc", shared, Buffer.from(ivPart, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(cipher, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
  const payload = Buffer.from(content, "base64");
  const conversationKey = createHmac("sha256", "nip44-v2").update(shared).digest();
  const nonce = payload.subarray(1, 33);
  const ciphertext = payload.subarray(33, payload.length - 32);
  let block = Buffer.alloc(0);
  let material = Buffer.alloc(0);
  for (let counter = 1; material.length < 76; counter += 1) {
    block = createHmac("sha256", conversationKey)
      .update(Buffer.concat([block, nonce, Buffer.from([counter])]))
      .digest();
    material = Buffer.concat([material, block]);
  }
  const chachaKey = material.subarray(0, 32);
  const chachaNonce = material.subarray(32, 44);
  const iv = Buffer.concat([Buffer.alloc(4), chachaNonce]);
  const decipher = createDecipheriv("chacha20", chachaKey, iv);
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const length = padded.readUInt16BE(0);
  return padded.subarray(2, 2 + length).toString("utf8");
}

export interface CapturedRequest {
  readonly at: number;
  readonly event: { readonly content: string; readonly tags?: readonly (readonly string[])[] };
}

/** The NWC method a captured request names, or undefined when it cannot be read with these codes. */
export function requestMethod(
  request: CapturedRequest,
  connections: readonly { walletPubkey: string; secret: string }[],
): { method: string; offset: number; unpaid: boolean } | undefined {
  for (const connection of connections) {
    try {
      const plain = decryptNip47Content(
        request.event.content,
        connection.secret,
        connection.walletPubkey,
      );
      const parsed = JSON.parse(plain) as {
        method?: unknown;
        params?: { offset?: unknown; unpaid?: unknown };
      };
      if (typeof parsed.method === "string") {
        return {
          method: parsed.method,
          offset: Number(parsed.params?.offset ?? 0) || 0,
          unpaid: parsed.params?.unpaid === true,
        };
      }
    } catch {}
  }
  return undefined;
}

export interface ScanAnalysis {
  readonly scans: number;
  readonly unclassified: number;
  readonly withinBudget: boolean;
  /** Seconds between consecutive scans, for the evidence. */
  readonly gaps: readonly number[];
}

/**
 * Whether scans honored the gate. One reconcile pass may list settled invoices
 * and pending ones, each with its own first page and later pages, so a pass is
 * counted once per kind of first page (offset 0), and the busier kind stands for
 * the passes. An unreadable request counts as a first page rather than vanishing.
 * `windowMs` bounds how many passes the budget allows at all; each gap must clear
 * the gate's floor, with slack because the interceptor stamps arrival, not the
 * gate's own clock.
 */
export function analyzeScans(
  requests: readonly CapturedRequest[],
  connections: readonly { walletPubkey: string; secret: string }[],
  windowMs: number,
): ScanAnalysis {
  let unclassified = 0;
  const settledPages: number[] = [];
  const unpaidPages: number[] = [];
  for (const request of requests) {
    const read = requestMethod(request, connections);
    if (read === undefined) {
      unclassified += 1;
      settledPages.push(request.at);
      continue;
    }
    if (read.method === "list_transactions" && read.offset === 0) {
      (read.unpaid ? unpaidPages : settledPages).push(request.at);
    }
  }
  const pages = settledPages.length >= unpaidPages.length ? settledPages : unpaidPages;
  const sorted = [...pages].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((at, index) => (at - (sorted[index] ?? at)) / 1000);
  const floor = GATE_INTERVAL_S - GATE_SLACK_S;
  const maxScans = Math.floor(windowMs / 1000 / GATE_INTERVAL_S) + 1;
  return {
    scans: sorted.length,
    unclassified,
    withinBudget: sorted.length <= maxScans && gaps.every((gap) => gap >= floor),
    gaps,
  };
}

/** The wallet requests the interceptor saw from this shop since `since`. */
async function capturedRequests(
  target: DevtoolsTarget,
  since: number,
): Promise<CapturedRequest[] | undefined> {
  const client = clientPrefix(target.directory);
  const response = await fetch(
    `${target.wallet.interceptor.control}/requests?client=${encodeURIComponent(client)}&since=${since}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok) return undefined;
  const body = (await response.json()) as { requests?: CapturedRequest[] };
  return body.requests ?? [];
}

/** Runs SQL against the shop's own SQLite file, in the stack's own language; SELECT rows come back as `a|b` lines. */
async function sqliteExec(
  target: DevtoolsTarget,
  service: string,
  tools: StackTools,
  statements: readonly string[],
): Promise<string> {
  const encoded = Buffer.from(JSON.stringify(statements)).toString("base64");
  const script =
    tools.sqlite === "python"
      ? `python - <<'PYEOF'
import base64, json, sqlite3
db = sqlite3.connect("/data/shop.sqlite", timeout=30)
for statement in json.loads(base64.b64decode("${encoded}")):
    for row in db.execute(statement).fetchall():
        print("|".join(str(value) for value in row))
db.commit()
PYEOF`
      : tools.sqlite === "node"
        ? `node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/data/shop.sqlite");
for (const statement of JSON.parse(Buffer.from("${encoded}", "base64").toString("utf8"))) {
  const prepared = db.prepare(statement);
  if (/^select/i.test(statement)) {
    for (const row of prepared.all()) console.log(Object.values(row).join("|"));
  } else {
    prepared.run();
  }
}
'`
        : tools.sqlite === "ruby"
          ? `bundle exec ruby -e '
require "sqlite3"
require "json"
db = SQLite3::Database.new("/data/shop.sqlite")
db.busy_timeout = 30000
JSON.parse("${encoded}".unpack1("m0")).each do |statement|
  if statement =~ /^select/i
    db.execute(statement).each { |row| puts row.join("|") }
  else
    db.execute(statement)
  end
end
'`
          : `php -r '
$db = new PDO("sqlite:/data/shop.sqlite");
$db->setAttribute(PDO::ATTR_TIMEOUT, 30);
foreach (json_decode(base64_decode("${encoded}"), true) as $statement) {
  if (preg_match("/^select/i", $statement)) {
    foreach ($db->query($statement, PDO::FETCH_NUM) as $row) echo implode("|", $row), "\\n";
  } else {
    $db->exec($statement);
  }
}
'`;
  const result = await shell(target.directory, service, script, 60_000);
  if (result.code !== 0) throw new Error(tail(result.output));
  return result.output;
}

function fulfilmentCounterStatements(table: string): string[] {
  return [
    "CREATE TABLE IF NOT EXISTS openreceive_devtools_fulfilments (order_id TEXT, new_status TEXT, old_status TEXT, at TEXT DEFAULT CURRENT_TIMESTAMP)",
    "DROP TRIGGER IF EXISTS openreceive_devtools_fulfilment",
    `CREATE TRIGGER openreceive_devtools_fulfilment AFTER UPDATE OF status ON ${table} WHEN NEW.status <> 'awaiting_payment' BEGIN INSERT INTO openreceive_devtools_fulfilments (order_id, new_status, old_status) VALUES (NEW.id, NEW.status, OLD.status); END`,
  ];
}

const REMOVE_FULFILMENT_COUNTER = [
  "DROP TRIGGER IF EXISTS openreceive_devtools_fulfilment",
  "DROP TABLE IF EXISTS openreceive_devtools_fulfilments",
];

function concurrently(calls: number, run: () => Promise<Answer>): Promise<Answer[]> {
  return Promise.all(Array.from({ length: calls }, () => run()));
}

function paymentHashIn(answers: readonly Answer[]): string | undefined {
  for (const answer of answers) {
    const hash = answer.body.match(/"payment_hash"\s*:\s*"([0-9a-f]{64})"/)?.[1];
    if (hash !== undefined) return hash;
  }
  return undefined;
}

function isSettled(answer: Answer): boolean {
  return answer.status === 200 && /"status"\s*:\s*"settled"/.test(answer.body);
}

/** How many workers of the expected kind are running, for the evidence. */
async function workerCount(
  target: DevtoolsTarget,
  service: string,
  worker: Workers,
): Promise<number> {
  const { output } = await shell(
    target.directory,
    service,
    `for proc in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < "$proc"; echo; done 2>/dev/null`,
    15_000,
  );
  return output.split("\n").filter((line) => worker.process.test(line)).length;
}

async function workersChecks(target: DevtoolsTarget, tools: StackTools): Promise<Check[]> {
  const workers = tools.workers;
  if (workers === undefined || tools.sqlite === undefined) return [];
  const service = serviceOf(target.platform);
  const pidFile = `${SCRATCH}-workers.pid`;
  const logFile = `${SCRATCH}-workers.log`;
  const table = tools.ordersTable ?? "orders";
  const log = target.log ?? (() => {});
  const gateSummary = `With ${WORKER_COUNT} workers at once, real wallet scans kept to the gate's budget of one per ${GATE_INTERVAL_S} s, across processes.`;
  const fiveSummary = `With ${WORKER_COUNT} workers at once, no concurrent checkout or payment check answered 5xx or went unanswered.`;
  const onceSummary = `With ${WORKER_COUNT} workers at once, a paid order was fulfilled once.`;
  const failAll = (evidence: string): Check[] => [
    check("workers_gate_budget", false, gateSummary, evidence),
    check("workers_no_5xx", false, fiveSummary, evidence),
    check("workers_fulfil_once", false, onceSummary, evidence),
  ];
  const connections = [
    parseNwcUri(target.wallet.nwc),
    ...Object.values(await codesInShopFiles(target.directory)).map((code) => parseNwcUri(code)),
  ].filter((value): value is { walletPubkey: string; secret: string } => value !== undefined);
  try {
    const container = await containerOf(target.directory, service);
    const base = `http://${await containerAddress(container)}:${WORKERS_PORT}`;
    log(`workers: ${WORKER_COUNT} on ${base}`);
    const startFailed = await startScratchProcess(target.directory, service, {
      cwd: APP_DIR,
      pidFile,
      logFile,
      port: WORKERS_PORT,
      start: `PORT=${WORKERS_PORT} exec sh -c '${workers.start.replaceAll("'", "'\\''").replaceAll("$PORT", String(WORKERS_PORT))}'`,
    });
    if (startFailed !== undefined) return failAll(startFailed);
    if (!(await waitForAnswer(`${base}/health`, 90_000))) {
      return failAll(
        `the workers did not answer ${base}/health\n${tail((await shell(target.directory, service, `tail -n 40 ${logFile}`, 15_000)).output)}`,
      );
    }
    const running = await workerCount(target, service, workers);
    await sqliteExec(target, service, tools, fulfilmentCounterStatements(table));

    const buyer = new Visitor(base, 3_000, 75_000);
    const order = await buyer.placeOrder();
    const page = buyer.orderPage(order);
    const answers: Answer[] = [];
    const checkouts = await concurrently(CONCURRENCY, () => buyer.createCheckoutOnce(order, page));
    answers.push(...checkouts);
    const hash = paymentHashIn(checkouts);
    if (hash === undefined) {
      return failAll(
        `no checkout got an invoice: ${checkouts.map((answer) => `${answer.status} ${answer.body.slice(0, 120)}`).join(", ")}`,
      );
    }
    const windowStart = Date.now();
    log("workers: concurrent payment checks");
    // Long enough for one scan even when older pending invoices stretch the gate to 12 s.
    for (let wave = 0; wave < 10; wave += 1) {
      answers.push(
        ...(await concurrently(CONCURRENCY, () => buyer.checkPayment(order, hash, page))),
      );
      await sleep(1_500);
    }
    const windowEnd = Date.now();
    const requests = await capturedRequests(target, windowStart);
    const gate: Check =
      requests === undefined
        ? check(
            "workers_gate_budget",
            false,
            gateSummary,
            "this interceptor does not record wallet requests (GET /requests); roll out the interceptor change",
          )
        : (() => {
            const inWindow = requests.filter(
              (request) => request.at >= windowStart && request.at <= windowEnd,
            );
            const analysis = analyzeScans(inWindow, connections, windowEnd - windowStart);
            return check(
              "workers_gate_budget",
              analysis.withinBudget && analysis.scans >= 1,
              gateSummary,
              `${analysis.scans} real scan(s) in ${Math.round((windowEnd - windowStart) / 1000)} s across ${running} worker processes (${analysis.unclassified} unreadable request(s), counted as scans); gaps ${analysis.gaps.map((gap) => gap.toFixed(1)).join(", ") || "none"} s`,
            );
          })();

    await target.wallet.settle(hash);
    log("workers: settled, concurrent payment checks after it");
    const deadline = Date.now() + 90_000;
    let settled = false;
    while (!settled && Date.now() < deadline) {
      const wave = await concurrently(CONCURRENCY, () => buyer.checkPayment(order, hash, page));
      answers.push(...wave);
      settled = wave.some(isSettled);
      await sleep(1_500);
    }
    answers.push(...(await concurrently(CONCURRENCY, () => buyer.checkPayment(order, hash, page))));
    await sleep(2_000);
    const rows = (
      await sqliteExec(target, service, tools, [
        `SELECT new_status, count(*) FROM openreceive_devtools_fulfilments WHERE order_id = '${order}' GROUP BY new_status`,
      ])
    )
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("|"));
    const repeated = rows.filter((row) => Number(row.split("|")[1]) > 1);
    const broken = answers.filter((answer) => answer.status === 0 || answer.status >= 500);
    const statusCounts = [...new Set(answers.map((answer) => answer.status))]
      .sort((a, b) => a - b)
      .map((status) => `${status}: ${answers.filter((answer) => answer.status === status).length}`)
      .join(", ");
    const refused = answers.find((answer) => answer.status >= 400 && answer.status < 500);
    return [
      gate,
      check(
        "workers_no_5xx",
        broken.length === 0 && settled,
        fiveSummary,
        `${answers.length} answers (${statusCounts})${settled ? "; settled" : "; never saw settled"}${refused === undefined ? "" : `; a refused one said ${refused.body.slice(0, 200)}`}${
          broken.length > 0
            ? `\n${broken
                .slice(0, 3)
                .map((answer) => answer.body.slice(0, 200))
                .join("\n")}`
            : ""
        }`,
      ),
      check(
        "workers_fulfil_once",
        settled && rows.length > 0 && repeated.length === 0,
        onceSummary,
        `order ${order}: fulfilments by new status: ${rows.join(", ") || "none"}${repeated.length > 0 ? " (repeated)" : ""}`,
      ),
    ];
  } catch (error) {
    const serverLog = await shell(target.directory, service, `tail -n 25 ${logFile}`, 15_000)
      .then((result) => result.output)
      .catch(() => "");
    const cause =
      error instanceof Error && error.cause !== undefined ? ` (${String(error.cause)})` : "";
    return failAll(`${String(error).slice(0, 400)}${cause}\n${tail(serverLog)}`);
  } finally {
    await stopScratchProcess(target.directory, service, pidFile);
    await sqliteExec(target, service, tools, REMOVE_FULFILMENT_COUNTER).catch(() => "");
    await shell(
      target.directory,
      service,
      `rm -f ${pidFile} ${logFile} /tmp/openreceive-devtools-cluster.mjs; rm -rf /tmp/openreceive-devtools-gunicorn`,
      60_000,
    ).catch(() => {});
  }
}

/**
 * Runs what applies to the shop's stack: the debug page, then the checks that
 * need a built shop. A step that throws is a failed check with the error, and
 * the next step still runs.
 */
export const DEVTOOLS_STEPS = ["debug", "build", "tests", "hot", "workers"] as const;
export type DevtoolsStep = (typeof DEVTOOLS_STEPS)[number];

export async function devtoolsChecks(
  target: DevtoolsTarget,
  only: readonly DevtoolsStep[] = DEVTOOLS_STEPS,
): Promise<Check[]> {
  const codes: Record<string, string> = {
    NWC_URI: target.wallet.nwc,
    LSC_URI_PRIMARY: target.wallet.lsc,
  };
  const checks: Check[] = only.includes("debug")
    ? await debugPageChecks(target.directory, target.platform, { codes })
    : [];
  const tools = stackTools(target.platform);
  if (tools === undefined) return checks;
  if (only.includes("build")) checks.push(...(await buildCheck(target, tools)));
  if (only.includes("tests")) checks.push(...(await ownTestChecks(target, tools)));
  if (only.includes("hot")) checks.push(...(await hotReloadCheck(target, tools)));
  if (only.includes("workers")) checks.push(...(await workersChecks(target, tools)));
  return checks;
}
