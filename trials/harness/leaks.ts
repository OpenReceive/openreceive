import { compose } from "./docker.ts";
import { check } from "./live.ts";
import type { Check, Platform } from "./types.ts";

// Where a framework, not the agent, shows the wallet codes to a browser. The
// agent can do everything right and the code still leaks if the framework's
// debug page prints it, so each probe renders that page inside the shop's own
// container, with the shop's own settings, and looks for the codes.

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

/** The debug-page probes that apply to a platform: Django's, today. */
export function debugPageProbes(platform: Platform): readonly string[] {
  const stack = platform.directions_slug ?? platform.slug;
  return stack === "django" ? ["django"] : [];
}

export async function debugPageChecks(directory: string, platform: Platform): Promise<Check[]> {
  if (!debugPageProbes(platform).includes("django")) return [];
  const service = platform.service ?? "web";
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
    return [
      check(
        "debug_page_hides_codes",
        shown !== undefined && shown.length === 0,
        summary,
        shown === undefined
          ? `the probe printed no result: ${result.stderr.slice(-300)}`
          : shown.length === 0
            ? "no code on the page"
            : `the page shows ${shown.join(", ")} in full`,
      ),
    ];
  } catch (error) {
    return [check("debug_page_hides_codes", false, summary, String(error).slice(0, 400))];
  }
}
