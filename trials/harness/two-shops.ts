import type { ChaosBuyer } from "./chaos.ts";
import type { Answer } from "./live.ts";
import { check } from "./live.ts";
import type { Check } from "./types.ts";

// Two running shops share one wallet code, as every trial already does and
// some merchants do on purpose (staging and production, or two storefronts on
// one Lightning address). Every invoice a shop mints lands in the same wallet
// history. A shop must never treat another shop's invoice as its own: settling
// shop A's invoice turns A paid and leaves B untouched, and neither shop's
// wallet scans may close the other's rows.

/** One running shop, as this check drives it. */
export interface TwoShopsSide {
  readonly name: string;
  readonly newBuyer: () => Promise<ChaosBuyer>;
  readonly orderStatus: (buyer: ChaosBuyer) => Promise<string>;
}

export interface TwoShopsInput {
  readonly a: TwoShopsSide;
  readonly b: TwoShopsSide;
  readonly settle: (paymentHash: string) => Promise<void>;
  readonly log?: (line: string) => void;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
}

const hashOf = (body: string) => body.match(/"payment_hash"\s*:\s*"([0-9a-f]{64})"/)?.[1];
const statusOf = (body: string) => body.match(/"status"\s*:\s*"([a-z_]+)"/)?.[1] ?? "";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One minted checkout, retried once on a 503 as a checkout's Try again would. */
async function mint(buyer: ChaosBuyer): Promise<{ answer: Answer; hash: string | undefined }> {
  let answer = await buyer.createOnce();
  if (answer.status === 503) answer = await buyer.createOnce();
  return { answer, hash: hashOf(answer.body) };
}

/** The verdict, on what was seen. Pure, so a test can hand it a shop that misbehaved. */
export function twoShopsVerdict(seen: {
  readonly aSettled: boolean;
  readonly aStatus: string;
  readonly bStatusWhileAPaid: string;
  readonly bOrderWhileAPaid: string;
  readonly aStatusLater: string;
  readonly bSettledLast: boolean;
}): Check[] {
  const aPaid = seen.aSettled && seen.aStatus.length > 0 && seen.aStatus !== "awaiting_payment";
  const bUnpaid =
    seen.bStatusWhileAPaid === "pending" && seen.bOrderWhileAPaid === "awaiting_payment";
  return [
    check(
      "two_shops_a_paid",
      aPaid,
      "Shop A's invoice settled in the shared wallet and A's own order turned paid.",
      `A settled ${seen.aSettled}, order ${seen.aStatus || "(unread)"}`,
    ),
    check(
      "two_shops_b_stays_unpaid",
      bUnpaid,
      "While A's invoice settled, shop B's invoice stayed pending and B's order stayed unpaid.",
      `B attempt ${seen.bStatusWhileAPaid || "(unread)"}, order ${seen.bOrderWhileAPaid || "(unread)"}`,
    ),
    check(
      "two_shops_neither_closed",
      seen.aStatusLater === "settled" && seen.bSettledLast,
      "Afterwards A is still settled, and B's own row was still live: settling B's invoice paid B.",
      `A ${seen.aStatusLater || "(unread)"}, B settled afterwards: ${seen.bSettledLast}`,
    ),
  ];
}

export async function twoShopsChecks(input: TwoShopsInput): Promise<Check[]> {
  const log = input.log ?? (() => {});
  const pollMs = input.pollMs ?? 3_000;
  const timeoutMs = input.timeoutMs ?? 90_000;
  const buyerA = await input.a.newBuyer();
  const buyerB = await input.b.newBuyer();
  const mintedA = await mint(buyerA);
  const mintedB = await mint(buyerB);
  log(`two-shops: minted on both: A ${mintedA.answer.status}, B ${mintedB.answer.status}`);
  const failedMint =
    mintedA.answer.status !== 201 ||
    mintedB.answer.status !== 201 ||
    !mintedA.hash ||
    !mintedB.hash;
  if (failedMint) {
    return [
      check(
        "two_shops_minted",
        false,
        "Both shops minted an invoice.",
        `A ${mintedA.answer.status}: ${mintedA.answer.body.slice(0, 160)}; B ${mintedB.answer.status}: ${mintedB.answer.body.slice(0, 160)}`,
      ),
    ];
  }
  const hashA = mintedA.hash as string;
  const hashB = mintedB.hash as string;
  await input.settle(hashA);
  let aSettled = false;
  let lastA: Answer = mintedA.answer;
  let bStatusWhileAPaid = "";
  let bOrderWhileAPaid = "";
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs);
    lastA = await buyerA.checkPayment(hashA);
    const b = await buyerB.checkPayment(hashB);
    bStatusWhileAPaid = statusOf(b.body);
    bOrderWhileAPaid = await input.b.orderStatus(buyerB);
    if (statusOf(lastA.body) === "settled") {
      aSettled = true;
      break;
    }
  }
  const aStatus = aSettled ? await input.a.orderStatus(buyerA) : "";
  // More passes over the shared history before anything is settled for B: a
  // scan on A that closed B's row, or the reverse, shows up here.
  for (let pass = 0; pass < 3; pass += 1) {
    await sleep(pollMs);
    await buyerA.checkPayment(hashA);
    const b = await buyerB.checkPayment(hashB);
    bStatusWhileAPaid = statusOf(b.body);
    bOrderWhileAPaid = await input.b.orderStatus(buyerB);
  }
  const aStatusLater = statusOf((await buyerA.checkPayment(hashA)).body);
  await input.settle(hashB);
  let bSettledLast = false;
  const bStarted = Date.now();
  while (Date.now() - bStarted < timeoutMs && !bSettledLast) {
    await sleep(pollMs);
    bSettledLast = statusOf((await buyerB.checkPayment(hashB)).body) === "settled";
  }
  log(`two-shops: A ${aSettled ? "settled" : "not settled"}, B ${bStatusWhileAPaid}`);
  return twoShopsVerdict({
    aSettled,
    aStatus,
    bStatusWhileAPaid,
    bOrderWhileAPaid,
    aStatusLater,
    bSettledLast,
  });
}
