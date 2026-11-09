import { compose } from "./docker.ts";
import type { Check, Platform } from "./types.ts";

// What OpenReceive a shop actually runs, read inside its containers. A tree
// trial must end on the tree's version, or it tested the wrong code.

const NODE_PACKAGES = `node -e '
const fs = require("fs");
for (const [dir, prefix] of [["node_modules/@openreceive", "@openreceive/"], ["node_modules", ""]]) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (prefix === "" && name !== "openreceive") continue;
    const file = dir + "/" + name + "/package.json";
    if (fs.existsSync(file)) console.log(prefix + name + " " + JSON.parse(fs.readFileSync(file, "utf8")).version);
  }
}'`;

const PYTHON_PACKAGE = `python3 -c 'from importlib.metadata import version; print("openreceive", version("openreceive"))'`;

const COMPOSER_PACKAGES = `php -r 'foreach (json_decode(file_get_contents("vendor/composer/installed.json"))->packages as $p) { if (str_starts_with($p->name, "openreceive/")) echo $p->name, " ", $p->version, "\\n"; }'`;

/** Read one file and print `<name> <version>`. */
function versionFrom(name: string, file: string, pattern: string): string {
  return `sed -En ${JSON.stringify(`s/.*${pattern}.*/${name} \\1/p`)} ${file} | head -1`;
}

interface InstalledProbe {
  readonly service: string;
  readonly script: string;
}

export function installedProbes(platform: Platform): InstalledProbe[] {
  const services = platform.wallet_services ?? [platform.service ?? "web"];
  const paths = platform.allowed_install_paths;
  if (platform.host === "paymenter") {
    return [
      {
        service: "paymenter",
        script: versionFrom(
          "openreceive-paymenter",
          "/app/extensions/Gateways/OpenReceive/Support/Runtime.php",
          "const VERSION = '([^']+)'",
        ),
      },
    ];
  }
  if (platform.host === "fossbilling") {
    return [
      {
        service: "fossbilling",
        script: versionFrom(
          "openreceive-fossbilling",
          "/var/www/html/modules/Openreceive/manifest.json",
          '"version": *"([^"]+)"',
        ),
      },
    ];
  }
  if (platform.host === "prestashop") {
    return [
      {
        service: "prestashop",
        script: versionFrom(
          "openreceive-prestashop",
          "/var/www/html/modules/openreceive/openreceive.php",
          "this->version = '([^']+)'",
        ),
      },
    ];
  }
  if (platform.host === "odoo") {
    return [
      { service: "odoo", script: PYTHON_PACKAGE },
      {
        service: "odoo",
        script: versionFrom(
          "payment_openreceive",
          "/mnt/extra-addons/payment_openreceive/__manifest__.py",
          '"version": *"([^"]+)"',
        ),
      },
    ];
  }
  if (platform.host === "btcpay" || paths.includes("btcpay-plugin-directory")) return [];
  if (platform.slug === "woocommerce" || platform.slug === "edd") {
    return [
      {
        service: "wordpress",
        script: versionFrom(
          "openreceive-wordpress",
          "/var/www/html/wp-content/plugins/openreceive/openreceive.php",
          "Version: *([0-9][^ ]*)",
        ),
      },
    ];
  }
  if (paths.includes("pip"))
    return services.map((service) => ({ service, script: PYTHON_PACKAGE }));
  if (paths.includes("gem")) {
    return services.map((service) => ({ service, script: "bundle list | grep openreceive" }));
  }
  if (paths.includes("composer")) {
    return services.map((service) => ({ service, script: COMPOSER_PACKAGES }));
  }
  return services.map((service) => ({ service, script: NODE_PACKAGES }));
}

export interface InstalledVersion {
  readonly service: string;
  readonly name: string;
  readonly version: string;
}

/** `name version` lines, `* name (version)` from Bundler, or nothing when a tool printed none. */
export function parseInstalled(service: string, output: string): InstalledVersion[] {
  const found: InstalledVersion[] = [];
  for (const line of output.split("\n")) {
    const bundler = /^\s*\*\s*(openreceive[\w-]*)\s*\(([^)]+)\)/.exec(line);
    const plain = /^(@?[\w./-]*openreceive[\w./-]*)\s+v?(\d+\.\d+\.\d+[\w.-]*)\s*$/.exec(
      line.trim(),
    );
    const match = bundler ?? plain;
    if (match?.[1] !== undefined && match[2] !== undefined) {
      found.push({ service, name: match[1], version: match[2] });
    }
  }
  return found;
}

/** Every OpenReceive package each service reports; a service without the tool reports nothing. */
export async function installedVersions(
  directory: string,
  platform: Platform,
): Promise<InstalledVersion[]> {
  const found: InstalledVersion[] = [];
  for (const probe of installedProbes(platform)) {
    const result = await compose(
      directory,
      ["exec", "-T", probe.service, "sh", "-c", probe.script],
      60_000,
      { quiet: true },
    ).catch(() => undefined);
    if (result !== undefined) found.push(...parseInstalled(probe.service, result.stdout));
  }
  return found;
}

export function describeInstalled(found: readonly InstalledVersion[]): string {
  return found.length === 0
    ? "no OpenReceive package found"
    : found.map((item) => `${item.service}: ${item.name} ${item.version}`).join("; ");
}

/**
 * A tree trial only counts if the shop's containers hold the tree's build. The
 * version is above every published release, so no published package can match.
 */
export function treeVersionCheck(
  found: readonly InstalledVersion[],
  version: string,
  /** The agent rightly stopped before installing: the merchant has no wallet code yet. */
  stoppedBeforeInstall = false,
): Check {
  const stale = found.filter((item) => item.version !== version);
  const pass = (found.length > 0 || stoppedBeforeInstall) && stale.length === 0;
  return {
    id: "tree_build_installed",
    severity: "blocker",
    pass,
    summary: `The shop runs OpenReceive ${version}, built from this tree.`,
    evidence: describeInstalled(found),
  };
}

/**
 * The registry's address in a file the agent committed, or would ship: a
 * throwaway shop's files are not harmed by it, so it is only recorded.
 */
export function registryLeakCheck(leaks: readonly string[]): Check {
  return {
    id: "tree_registry_in_shop_files",
    severity: "polish",
    pass: leaks.length === 0,
    summary: "No shop file a merchant would ship names the tree registry.",
    evidence: leaks.length === 0 ? undefined : leaks.join("\n"),
  };
}
