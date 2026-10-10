import path from "node:path";
import { fileURLToPath } from "node:url";
import { compose } from "./docker.ts";

// The trial chain (trials/chain/compose.yml): the pruned mainnet bitcoind and
// NBXplorer every BTCPay trial shares. Bringing it up never waits for the
// node to sync; a BTCPay store on a remote Lightning wallet works meanwhile.

const chainDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../chain");
const COMPOSE_ARGS = [
  "-p",
  "openreceive-trial-chain",
  "-f",
  path.join(chainDir, "compose.yml"),
] as const;

/** Start the chain, or leave it running. It joins the trial wallet's network, so start that first. */
export async function startTrialChain(): Promise<void> {
  await compose(
    chainDir,
    [...COMPOSE_ARGS, "up", "-d", "--wait", "--wait-timeout", "300"],
    360_000,
  );
}
