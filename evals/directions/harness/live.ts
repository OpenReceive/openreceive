import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Check } from "./types.ts";

// The live checks every published shop gets, wherever it runs: it answers,
// a buyer's own order gets a real Lightning invoice, and a stranger asking for
// that order is refused. Nothing is paid.

export function check(id: string, pass: boolean, summary: string, evidence?: string): Check {
  return { id, severity: "blocker", pass, summary, evidence };
}

async function sourceFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", ".next", ".vercel", "node_modules"].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (/\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** The agent's source files and their text, keyed by absolute path. */
export async function sourceTexts(directory: string): Promise<Map<string, string>> {
  const files = await sourceFiles(directory);
  return new Map(
    await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")] as const)),
  );
}

/** The order the fixture's own form creates, with the cookie that owns it. */
async function placeOrder(base: string): Promise<{ id: string; cookie: string }> {
  const response = await fetch(`${base}/orders`, {
    method: "POST",
    body: new URLSearchParams({ product_id: "1" }),
    redirect: "manual",
  });
  // The fixture redirects to /orders/<id>; an integration may send the buyer
  // straight to its checkout page instead. Either way the id ends the path.
  const location = response.headers.get("location") ?? "";
  const id = new URL(location, base).pathname.match(/\/(\d+)\/?$/)?.[1];
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  if (id === undefined || !cookie.startsWith("widget_user=")) {
    throw new Error(`POST /orders answered ${response.status} without an order and its cookie`);
  }
  return { id, cookie };
}

async function createCheckout(
  base: string,
  reference: string,
  cookie?: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${base}/openreceive/checkouts`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify({ reference }),
  });
  return { status: response.status, body: await response.text() };
}

export async function liveShopChecks(base: string): Promise<Check[]> {
  const checks: Check[] = [];
  const health = await fetch(`${base}/health`)
    .then((response) => response.status)
    .catch(() => 0);
  checks.push(check("live_health", health === 200, "The shop answers GET /health.", `${health}`));

  try {
    const order = await placeOrder(base);
    const own = await createCheckout(base, order.id, order.cookie);
    const bolt11 = own.body.match(/"bolt11"\s*:\s*"(ln[a-z0-9]+)"/i)?.[1];
    checks.push(
      check(
        "live_invoice",
        own.status === 201 && bolt11 !== undefined,
        "The shop issued a real Lightning invoice for the buyer's own order.",
        bolt11 === undefined
          ? `${own.status} ${own.body.slice(0, 300)}`
          : `${own.status} ${bolt11.slice(0, 16)}…`,
      ),
    );
    const stranger = await createCheckout(base, order.id);
    checks.push(
      check(
        "live_refuses_stranger",
        stranger.status === 401 || stranger.status === 403,
        "The shop refused a checkout for someone else's order.",
        `${stranger.status}`,
      ),
    );
  } catch (error) {
    checks.push(
      check("live_invoice", false, "The shop issued a real Lightning invoice.", String(error)),
    );
  }
  return checks;
}
