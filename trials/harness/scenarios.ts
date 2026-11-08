import type { Scenario } from "./types.ts";

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
  // A chat app broke the long code over two lines.
  "wrapped-paste": {
    id: "wrapped-paste",
    prompt: "",
    swaps: true,
    choice: "Yes, stablecoins too.",
    paste: "wrapped",
  },
};

/** The order `mix` deals scenarios in: run 1 canonical, run 2 a mangled paste, run 3 Bitcoin only. */
const MIX = ["canonical", "wrapped-paste", "bitcoin-only", "quoted-paste", "env-line-paste"];

export function scenarioFor(spec: string, runIndex: number): Scenario {
  const name = spec === "mix" ? (MIX[runIndex % MIX.length] ?? "canonical") : spec;
  const scenario = SCENARIOS[name];
  if (scenario === undefined) {
    throw new Error(
      `Unknown scenario "${spec}". Scenarios: ${Object.keys(SCENARIOS).join(", ")}, mix`,
    );
  }
  return scenario;
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
