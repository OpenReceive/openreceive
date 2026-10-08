import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { parseEnv } from "./codes.ts";
import { InfraError } from "./docker.ts";
import { check, liveShopChecks, sourceTexts } from "./live.ts";
import type { Check } from "./types.ts";

// The Vercel eval deploys the agent's finished shop to one project in the
// OpenReceive team, then pays nothing and checks the live site: a real
// invoice for an order, and a refusal for a stranger. The project's Neon
// database is wiped first, so tables left by an earlier run cannot hide a
// missing migration.

const PROJECT = "openreceive-eval";
const CLI = "vercel@62.7.0";
const API = "https://api.vercel.com";
const DEPLOY_TIMEOUT_MS = 20 * 60 * 1000;

export interface VercelConfig {
  readonly token: string;
  readonly teamId: string;
}

export async function loadVercelConfig(envFile: string): Promise<VercelConfig> {
  const values = parseEnv(await readFile(envFile, "utf8").catch(() => ""));
  const token = values.VERCEL_TOKEN ?? "";
  const teamId = values.VERCEL_TEAM_ID ?? "";
  if (token === "" || teamId === "") {
    throw new InfraError(
      "The Vercel eval needs VERCEL_TOKEN and VERCEL_TEAM_ID in the repo-root .env.",
    );
  }
  return { token, teamId };
}

async function api<T>(
  config: VercelConfig,
  method: string,
  route: string,
  body?: unknown,
): Promise<T> {
  const separator = route.includes("?") ? "&" : "?";
  const response = await fetch(`${API}${route}${separator}teamId=${config.teamId}`, {
    method,
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new InfraError(
      `Vercel ${method} ${route.split("?")[0]} answered ${response.status}: ${text.slice(0, 300)}`,
    );
  }
  return (text.length > 0 ? JSON.parse(text) : {}) as T;
}

function run(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["-y", CLI, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}

/** What the agent left in the code, read before anything is deployed. */
async function codeChecks(directory: string): Promise<Check[]> {
  const texts = await sourceTexts(directory);
  const relative = (file: string) => path.relative(directory, file);
  const edge = [...texts].find(
    ([, text]) =>
      /export\s+const\s+runtime\s*=\s*["']edge["']/.test(text) && /openreceive/i.test(text),
  );
  const vercelJson = texts.get(path.join(directory, "vercel.json"));
  const cron = vercelJson !== undefined && /"crons"/.test(vercelJson);
  const worker = [...texts].find(([, text]) => /startNotificationWorker/.test(text));
  return [
    check(
      "node_runtime",
      edge === undefined,
      "The payment route does not run on the Edge runtime.",
      edge === undefined ? undefined : relative(edge[0]),
    ),
    check(
      "no_cron_or_worker",
      !cron && worker === undefined,
      "The agent added no Vercel cron job and no notifications worker; settlement runs on requests.",
      cron ? "vercel.json crons" : worker === undefined ? undefined : relative(worker[0]),
    ),
  ];
}

interface EnvEntry {
  readonly id: string;
  readonly key: string;
  readonly target?: readonly string[] | string;
}

/** The direct Neon URL, pulled the way `vercel env pull` does, then deleted. */
async function unpooledUrl(linked: string, env: NodeJS.ProcessEnv): Promise<string> {
  const file = path.join(await mkdtempDir(), "pulled.env");
  try {
    const pulled = await run(
      ["env", "pull", file, "--yes", "--environment", "production"],
      linked,
      env,
      120_000,
    );
    if (pulled.code !== 0) throw new InfraError("vercel env pull failed for the eval project.");
    const values = parseEnv(await readFile(file, "utf8"));
    const url = values.DATABASE_URL_UNPOOLED ?? "";
    if (url === "")
      throw new InfraError(
        `The ${PROJECT} project has no DATABASE_URL_UNPOOLED. Connect its Neon database.`,
      );
    return url;
  } finally {
    await rm(path.dirname(file), { recursive: true, force: true });
  }
}

async function mkdtempDir(): Promise<string> {
  const directory = path.join(tmpdir(), `oreval-vercel-${Math.random().toString(16).slice(2, 10)}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function wipe(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } finally {
    await client.end();
  }
}

/**
 * Deploy the agent's shop and check it live. `codes` become the project's
 * NWC_URI and LSC_URI_PRIMARY, as a merchant would set them in Vercel.
 */
export async function vercelChecks(
  directory: string,
  config: VercelConfig,
  codes: { readonly nwc: string; readonly lsc: string },
  log: (line: string) => void,
): Promise<Check[]> {
  const checks = await codeChecks(directory);
  const project = await api<{ id: string }>(config, "GET", `/v9/projects/${PROJECT}`).catch(() => {
    throw new InfraError(
      `Create the ${PROJECT} project in the Vercel team and connect a Neon database to it.`,
    );
  });
  // The token reaches the CLI through its environment, never its arguments.
  const env = { ...process.env, VERCEL_TOKEN: config.token, VERCEL_TELEMETRY_DISABLED: "1" };
  await mkdir(path.join(directory, ".vercel"), { recursive: true });
  await writeFile(
    path.join(directory, ".vercel", "project.json"),
    `${JSON.stringify({ projectId: project.id, orgId: config.teamId })}\n`,
  );

  log(`vercel wipe ${PROJECT} database`);
  await wipe(await unpooledUrl(directory, env));

  const existing = await api<{ envs: EnvEntry[] }>(config, "GET", `/v9/projects/${project.id}/env`);
  for (const [key, value] of [
    ["NWC_URI", codes.nwc],
    ["LSC_URI_PRIMARY", codes.lsc],
  ] as const) {
    for (const entry of existing.envs.filter((item) => item.key === key)) {
      await api(config, "DELETE", `/v9/projects/${project.id}/env/${entry.id}`);
    }
    await api(config, "POST", `/v10/projects/${project.id}/env`, {
      key,
      value,
      type: "encrypted",
      target: ["production", "preview", "development"],
    });
  }

  log(`vercel deploy ${PROJECT}`);
  const deployed = await run(["deploy", "--prod", "--yes"], directory, env, DEPLOY_TIMEOUT_MS);
  const deploymentUrl = deployed.output.match(/https:\/\/[a-z0-9-]+\.vercel\.app/g)?.at(-1);
  checks.push(
    check(
      "deploy_built",
      deployed.code === 0 && deploymentUrl !== undefined,
      "Vercel built and deployed the shop.",
      deployed.code === 0
        ? deploymentUrl
        : deployed.output.split("\n").filter(Boolean).slice(-12).join("\n"),
    ),
  );
  if (deployed.code !== 0 || deploymentUrl === undefined) return checks;

  const domains = await api<{ domains: { name: string; verified: boolean }[] }>(
    config,
    "GET",
    `/v9/projects/${project.id}/domains`,
  );
  const domain = domains.domains.find(
    (item) => item.verified && item.name.endsWith(".vercel.app"),
  )?.name;
  const base = domain === undefined ? deploymentUrl : `https://${domain}`;
  log(`vercel live ${base}`);

  checks.push(...(await liveShopChecks(base)));
  return checks;
}
