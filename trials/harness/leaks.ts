import { readFile } from "node:fs/promises";
import path from "node:path";
import { containsSecret } from "./checks.ts";
import { compose } from "./docker.ts";
import { check } from "./live.ts";
import type { Check, Platform } from "./types.ts";

// Where a framework, not the agent, shows the wallet codes to a browser. The
// agent can do everything right and the code still leaks if the framework's
// debug page prints it, so each probe renders that page inside the shop's own
// container, with the shop's own settings, and looks for the codes. Nothing
// here prints a code: a probe writes the page to a file, the harness reads it
// back and names which codes it found.

/**
 * Django's DEBUG page, as `manage.py runserver` serves it. runserver's WSGI
 * handler copies the process environment into request.META, and the page
 * lists META, hiding only names that match API|AUTH|TOKEN|KEY|SECRET|PASS|
 * SIGNATURE. NWC_URI matches none of them. The probe builds the request the
 * way runserver does and renders the page through the shop's configured
 * exception reporter filter, so a filter the shop sets is honored.
 */
export const DJANGO_DEBUG_PROBE = `
import os, sys
from django.test import RequestFactory
from django.views.debug import technical_500_response
request = RequestFactory().get("/", **dict(os.environ))
try:
    raise RuntimeError("openreceive trial probe")
except RuntimeError:
    html = technical_500_response(request, *sys.exc_info()).content.decode()
shown = []
for name, value in os.environ.items():
    if not value.startswith(("nostr+walletconnect://", "lightning+swapconnect://")):
        continue
    secret = value.split("secret=")[-1][:16] if "secret=" in value else value[-16:]
    if secret and secret in html:
        shown.append(name)
print("OPENRECEIVE_PROBE shown=" + ",".join(sorted(shown)))
`;

/** The names the probe found on the page, or undefined when it printed no result line. */
export function probeShown(stdout: string): string[] | undefined {
  const line = stdout
    .split("\n")
    .reverse()
    .find((text) => text.startsWith("OPENRECEIVE_PROBE shown="));
  if (line === undefined) return undefined;
  const names = line.slice("OPENRECEIVE_PROBE shown=".length).trim();
  return names === "" ? [] : names.split(",");
}

const PROBE_MARKER = "openreceive trial probe";
const PAGE_FILE = "/tmp/openreceive-debug-page.html";
const SCRIPT_FILE = "/tmp/openreceive-debug-probe";

/** Runs in the shop's container, in its app directory, and writes the page to PAGE_FILE. */
interface PageProbe {
  readonly summary: string;
  readonly script: string;
  /** How the script runs, from the app directory. */
  readonly run: string;
  /** Next compiles on demand. */
  readonly timeoutMs?: number;
}

const LARAVEL_PROBE: PageProbe = {
  summary:
    "With APP_DEBUG on, Laravel's error page shows no wallet code, the way a developer meets it after an exception.",
  run: `php ${SCRIPT_FILE}`,
  script: `<?php
putenv('APP_DEBUG=true');
$_ENV['APP_DEBUG'] = $_SERVER['APP_DEBUG'] = 'true';
putenv('APP_ENV=local');
$_ENV['APP_ENV'] = $_SERVER['APP_ENV'] = 'local';
$root = getcwd();
require $root.'/vendor/autoload.php';
$app = require $root.'/bootstrap/app.php';
$kernel = $app->make(Illuminate\\Contracts\\Http\\Kernel::class);
$app->booted(static function () {
    Illuminate\\Support\\Facades\\Route::get('/__openreceive_probe', static function () {
        throw new RuntimeException('openreceive trial probe');
    });
});
$_SERVER['REQUEST_URI'] = '/__openreceive_probe';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['SERVER_NAME'] = 'localhost';
$response = $kernel->handle(Illuminate\\Http\\Request::capture());
file_put_contents('${PAGE_FILE}', $response->getContent());
`,
};

const RAILS_PROBE: PageProbe = {
  summary:
    "Rails' development error page (the one a developer gets from `bin/rails server`) shows no wallet code.",
  run: `RAILS_ENV=development DATABASE_URL="\${DATABASE_URL:-sqlite3:/data/shop.sqlite}" bundle exec ruby ${SCRIPT_FILE}`,
  script: `require File.join(Dir.pwd, "config/environment")
Rails.application.routes.append do
  get "/__openreceive_probe", to: ->(_env) { raise "openreceive trial probe" }
end
Rails.application.routes_reloader.reload!
Rails.application.env_config["action_dispatch.show_detailed_exceptions"] = true
Rails.application.env_config["action_dispatch.show_exceptions"] = :all
require "rack/mock"
response = Rack::MockRequest.new(Rails.application).get(
  "/__openreceive_probe", "HTTP_HOST" => "localhost", "REMOTE_ADDR" => "127.0.0.1"
)
File.write("${PAGE_FILE}", response.body)
`,
};

const FLASK_PROBE: PageProbe = {
  summary: "Flask's debugger page, as `flask run --debug` serves it, shows no wallet code.",
  run: `python ${SCRIPT_FILE}`,
  script: `import os, sys
sys.path.insert(0, os.getcwd())
from flask.cli import ScriptInfo
from werkzeug.debug import DebuggedApplication
from werkzeug.test import Client

flask_app = ScriptInfo().load_app()
flask_app.debug = True
flask_app.testing = False

def probe():
    raise RuntimeError("openreceive trial probe")

flask_app.add_url_rule("/__openreceive_probe", "__openreceive_probe", probe)
page = Client(DebuggedApplication(flask_app, evalex=False)).get("/__openreceive_probe")
with open("${PAGE_FILE}", "w") as out:
    out.write(page.get_data(as_text=True))
`,
};

const NEXT_PROBE: PageProbe = {
  summary:
    "Next's dev error page, the one `next dev` serves and its overlay reads, shows no wallet code.",
  run: `sh ${SCRIPT_FILE}`,
  timeoutMs: 5 * 60_000,
  script: `set -e
SCRATCH=/tmp/openreceive-debug-next
rm -rf "$SCRATCH"
cp -a . "$SCRATCH"
cd "$SCRATCH"
rm -rf .next
APP=app
[ -d src/app ] && APP=src/app
mkdir -p "$APP/openreceive-debug-probe"
cat > "$APP/openreceive-debug-probe/page.js" <<'PROBE'
export const dynamic = "force-dynamic";
export default function Probe() {
  throw new Error("openreceive trial probe");
}
PROBE
setsid sh -c 'echo $$ > /tmp/openreceive-debug-next.pid; exec env NODE_ENV=development ./node_modules/.bin/next dev -H 127.0.0.1 -p 39010' >/tmp/openreceive-debug-next.log 2>&1 &
node -e '
const fs = require("node:fs");
(async () => {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:39010/openreceive-debug-probe");
      const body = await response.text();
      if (response.status >= 500 || /__next_error__|openreceive trial probe/.test(body)) {
        fs.writeFileSync("${PAGE_FILE}", body);
        process.exit(0);
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  process.exit(1);
})();
' || true
group=$(cat /tmp/openreceive-debug-next.pid)
for signal in TERM KILL; do
  for entry in /proc/[0-9]*; do
    stat=$(cat "$entry/stat" 2>/dev/null) || continue
    session=$(printf '%s\\n' "\${stat##*) }" | cut -d' ' -f4)
    [ "$session" = "$group" ] && kill -s "$signal" "\${entry##*/}" 2>/dev/null
  done
  sleep 2
done
cd /
rm -rf "$SCRATCH"
[ -s ${PAGE_FILE} ]
`,
};

const PAGE_PROBES: Readonly<Record<string, PageProbe>> = {
  laravel: LARAVEL_PROBE,
  rails: RAILS_PROBE,
  flask: FLASK_PROBE,
  next: NEXT_PROBE,
};

/** The debug-page probes that apply to a platform. */
export function debugPageProbes(platform: Platform): readonly string[] {
  const stack = platform.directions_slug ?? platform.slug;
  if (stack === "django") return ["django"];
  return Object.hasOwn(PAGE_PROBES, stack) ? [stack] : [];
}

/** The codes a shop holds in its own env files, by name. A placeholder is not a code. */
export async function codesInShopFiles(directory: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const name of [".env", ".env.local", ".env.production", ".env.development"]) {
    const text = await readFile(path.join(directory, name), "utf8").catch(() => "");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?(NWC_URI|LSC_URI_[A-Z0-9_]+)\s*=\s*(.*)$/);
      if (match === null) continue;
      const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
      if (/^(?:nostr\+walletconnect|lightning\+swapconnect):\/\//.test(value)) {
        found[match[1] as string] = value;
      }
    }
  }
  return found;
}

/** Which of the codes appear on the page, full or by their secret part; a bare code's scheme counts too. */
export function codesShown(page: string, codes: Readonly<Record<string, string>>): string[] {
  const shown = Object.entries(codes)
    .filter(([, value]) => value.length > 0 && containsSecret(page, [value]))
    .map(([name]) => name);
  if (page.includes("nostr+walletconnect://") && !shown.includes("NWC_URI")) shown.push("NWC_URI");
  if (page.includes("lightning+swapconnect://") && !shown.some((name) => name.startsWith("LSC"))) {
    shown.push("LSC_URI");
  }
  return [...new Set(shown)];
}

async function renderedPageCheck(
  directory: string,
  service: string,
  probe: PageProbe,
  codes: Readonly<Record<string, string>>,
): Promise<Check> {
  const encoded = Buffer.from(probe.script).toString("base64");
  try {
    await compose(
      directory,
      [
        "exec",
        "-T",
        service,
        "sh",
        "-c",
        `rm -f ${PAGE_FILE}; printf %s '${encoded}' | base64 -d > ${SCRIPT_FILE}; ${probe.run}`,
      ],
      probe.timeoutMs ?? 2 * 60_000,
      { quiet: true },
    );
    const { stdout: page } = await compose(
      directory,
      ["exec", "-T", service, "cat", PAGE_FILE],
      30_000,
      { quiet: true },
    );
    const rendered = page.includes(PROBE_MARKER);
    const shown = codesShown(page, codes);
    return check(
      "debug_page_hides_codes",
      rendered && shown.length === 0,
      probe.summary,
      !rendered
        ? "the probe got no debug page carrying its exception, so it proves nothing"
        : shown.length === 0
          ? `no code on the rendered page (${page.length} bytes)`
          : `the page shows ${shown.join(", ")}`,
    );
  } catch (error) {
    return check("debug_page_hides_codes", false, probe.summary, String(error).slice(0, 600));
  } finally {
    await compose(
      directory,
      [
        "exec",
        "-T",
        service,
        "sh",
        "-c",
        `rm -rf ${PAGE_FILE} ${SCRIPT_FILE} /tmp/openreceive-debug-next /tmp/openreceive-debug-next.log /tmp/openreceive-debug-next.pid`,
      ],
      30_000,
      { quiet: true },
    ).catch(() => undefined);
  }
}

async function djangoPageCheck(directory: string, service: string): Promise<Check> {
  const summary =
    "With DEBUG on, Django's error page would not show the wallet codes (runserver copies the environment into request.META).";
  try {
    const result = await compose(
      directory,
      ["exec", "-T", service, "python", "manage.py", "shell", "-c", DJANGO_DEBUG_PROBE],
      120_000,
      { quiet: true },
    );
    const shown = probeShown(result.stdout);
    return check(
      "debug_page_hides_codes",
      shown !== undefined && shown.length === 0,
      summary,
      shown === undefined
        ? `the probe printed no result: ${result.stderr.slice(-300)}`
        : shown.length === 0
          ? "no code on the page"
          : `the page shows ${shown.join(", ")} in full`,
    );
  } catch (error) {
    return check("debug_page_hides_codes", false, summary, String(error).slice(0, 400));
  }
}

export async function debugPageChecks(
  directory: string,
  platform: Platform,
  options: { readonly codes?: Readonly<Record<string, string>> } = {},
): Promise<Check[]> {
  const [probe] = debugPageProbes(platform);
  if (probe === undefined) return [];
  const service = platform.service ?? "web";
  if (probe === "django") return [await djangoPageCheck(directory, service)];
  const codes = { ...(options.codes ?? {}), ...(await codesInShopFiles(directory)) };
  return [await renderedPageCheck(directory, service, PAGE_PROBES[probe] as PageProbe, codes)];
}
