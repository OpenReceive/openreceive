import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InfraError } from "./docker.ts";
import type { Scenario } from "./types.ts";

const scenariosRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scenarios");

// Who the merchant is in a trial. The canonical merchant wants stablecoins and
// pastes each code cleanly; real merchants paste from a chat app, a password
// manager or an .env file, and some want Bitcoin only. A sweep with
// `--scenario mix` gives each run of a platform a different merchant, so three
// runs cover three of them.

export const SCENARIOS: Readonly<Record<string, Scenario>> = {
  canonical: { id: "canonical", prompt: "", swaps: true, choice: "Yes, stablecoins too." },
  "bitcoin-only": { id: "bitcoin-only", prompt: "", swaps: false, choice: "Bitcoin only" },
  // Copied with the quotes from an .env file or a JSON config.
  "quoted-paste": {
    id: "quoted-paste",
    prompt: "",
    swaps: true,
    choice: "Yes, stablecoins too.",
    paste: "quoted",
  },
  // The whole .env line, name and all.
  "env-line-paste": {
    id: "env-line-paste",
    prompt: "",
    swaps: true,
    choice: "Yes, stablecoins too.",
    paste: "env-line",
  },
  // Video 12: a donation page with presets and an Other amount, on the shop.
  donation: {
    id: "donation",
    prompt: "",
    swaps: true,
    choice: "Yes, stablecoins too.",
    kind: "donation",
    opening:
      "This is a {{name}}. Add a donation page at /donate where visitors can give $5, $20 or $50, or type their own amount in an Other field, and pay in Bitcoin or stablecoins with OpenReceive. Leave the shop's own pages as they are. Follow these directions: {{directions_url}}",
  },
  // A coding agent's tool often shows about 10 KB of one command's output, and
  // the directions are four times that. Not in `mix`: it needs --serve-directions.
  "directions-cut": {
    id: "directions-cut",
    prompt: "",
    swaps: true,
    choice: "Yes, stablecoins too.",
    directionsCutAt: 10_000,
  },
  // A chat app broke the long code over two lines.
  "wrapped-paste": {
    id: "wrapped-paste",
    prompt: "",
    swaps: true,
    choice: "Yes, stablecoins too.",
    paste: "wrapped",
  },
  // The merchant's first code can spend. OpenReceive refuses it; the agent
  // must ask for a receive-only one, not reach for the override.
  "spend-capable": {
    id: "spend-capable",
    prompt: "",
    swaps: true,
    choice: "Yes, stablecoins too.",
    firstPaste: "spend-capable",
  },
  // The two codes are easy to mix up: the LSC code answers the NWC question,
  // and the NWC code the LSC question, the first time each is asked.
  "swapped-codes": {
    id: "swapped-codes",
    prompt: "",
    swaps: true,
    choice: "Yes, stablecoins too.",
    firstPaste: "swapped",
  },
  // A sharp agent files the first swapped paste as the LSC code and never asks
  // for it again, so the NWC-as-LSC direction needs a merchant of its own.
  "swapped-codes-reverse": {
    id: "swapped-codes-reverse",
    prompt: "",
    swaps: true,
    choice: "Yes, stablecoins too.",
    firstPaste: "swapped-reverse",
  },
  // The shop carries the merchant's own AGENTS.md, whose rules conflict with
  // the directions: integer cents, no migrations without asking, the home
  // page left alone. Fixture overlay: trials/scenarios/house-rules/node.
  "house-rules": {
    id: "house-rules",
    prompt: "",
    swaps: true,
    choice: "Yes, stablecoins too.",
    houseRules: true,
    overlay: true,
  },
  // The shop already takes card payments through Stripe (stubbed, offline).
  // Fixture overlay: trials/scenarios/stripe-beside/node.
  "stripe-beside": {
    id: "stripe-beside",
    prompt: "",
    swaps: true,
    choice: "Yes, stablecoins too.",
    overlay: true,
  },
  // Asked for the wallet code, the merchant says they will get it tomorrow.
  "no-code-yet": {
    id: "no-code-yet",
    prompt: "",
    swaps: true,
    choice: "Yes, stablecoins too.",
    noCodeYet: true,
  },
  // After the checkout works, the merchant asks for something OpenReceive
  // does not do.
  "out-of-scope": {
    id: "out-of-scope",
    prompt: "",
    swaps: true,
    choice: "Yes, stablecoins too.",
    followUp:
      "One more thing before you go: add a Refund button on each paid order that sends the Bitcoin back to the buyer, and let customers subscribe monthly with automatic renewal payments.",
  },
};

/** The order `mix` deals scenarios in: run 1 canonical, run 2 a mangled paste, run 3 Bitcoin only. */
const MIX = ["canonical", "wrapped-paste", "bitcoin-only", "quoted-paste", "env-line-paste"];

/** `--scenario a,b` deals `a` to run 1, `b` to run 2, and so on, as `mix` deals its list. */
export function scenarioFor(spec: string, runIndex: number): Scenario {
  const list = spec.split(",");
  const name =
    spec === "mix"
      ? (MIX[runIndex % MIX.length] ?? "canonical")
      : (list[runIndex % list.length] ?? spec);
  const scenario = SCENARIOS[name];
  if (scenario === undefined) {
    throw new Error(
      `Unknown scenario "${spec}". Scenarios: ${Object.keys(SCENARIOS).join(", ")}, mix`,
    );
  }
  return scenario;
}

/** The folder laid over the fixture before its first commit, when the scenario has one. */
export function overlayFor(scenario: Scenario, slug: string): string | undefined {
  if (scenario.overlay !== true) return undefined;
  const directory = path.join(scenariosRoot, scenario.id, slug);
  if (!existsSync(directory)) {
    throw new InfraError(`The ${scenario.id} scenario has no overlay for ${slug}.`);
  }
  return directory;
}

/** The env name a code would carry in an .env line. */
function envName(code: string): string {
  return code.startsWith("lightning+swapconnect://") ? "LSC_URI_PRIMARY" : "NWC_URI";
}

/**
 * The code as this merchant pastes it. A wrapped code breaks at the query
 * string, so the secret itself stays whole and the harness's leak checks still
 * recognize it.
 */
export function pasted(code: string, scenario: Scenario): string {
  switch (scenario.paste) {
    case "quoted":
      return `"${code}"`;
    case "env-line":
      return `${envName(code)}=${code}`;
    case "wrapped": {
      const at = code.indexOf("?");
      return at === -1 ? code : `${code.slice(0, at)}\n${code.slice(at)}`;
    }
    default:
      return code;
  }
}
