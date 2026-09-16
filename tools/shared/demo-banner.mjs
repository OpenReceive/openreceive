// The one place the demo launcher draws the "your demo is at <url>" block.
//
// `docker compose up` attaches every container's log to the terminal, so a
// single "Starting … -> http://localhost:3006" line printed before the flood
// has scrolled away by the time the app is up. The launcher draws this banner
// twice: once at start, and again — highlighted — the moment the published
// port first answers, so the address is the last thing the reader's eye lands
// on when the stack goes quiet.

const BOLD_GREEN = "\x1b[1;32m";
const RESET = "\x1b[0m";

/**
 * A boxed banner. `color` wraps it in bold green for a TTY; tests and piped
 * output get the plain box.
 */
export function formatDemoBanner({ title, url, lines = [], color = false }) {
  const rows = [title, "", url, ...(lines.length === 0 ? [] : ["", ...lines])];
  const width = Math.max(...rows.map((row) => row.length));
  const bar = "═".repeat(width + 2);
  const box = [`╔${bar}╗`, ...rows.map((row) => `║ ${row.padEnd(width)} ║`), `╚${bar}╝`].join("\n");
  return color ? `${BOLD_GREEN}${box}${RESET}` : box;
}

/**
 * Resolve `true` the first time `url` answers over HTTP (any status: a 404
 * from a listening server is still "listening"), `false` when `signal`
 * aborts or `timeoutMs` passes first. Connection refusals are the expected
 * state while containers build, so they are swallowed and retried.
 */
export async function waitForHttp({
  url,
  fetchImpl = fetch,
  intervalMs = 1000,
  timeoutMs = 15 * 60 * 1000,
  signal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const deadline = Date.now() + timeoutMs;
  while (!signal?.aborted && Date.now() < deadline) {
    try {
      await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(intervalMs) });
      return true;
    } catch {
      // Not listening yet.
    }
    await sleep(intervalMs);
  }
  return false;
}
