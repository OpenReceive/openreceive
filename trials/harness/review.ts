import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS, type AgentName } from "./agents.ts";
import { cursorEnv } from "./cursor.ts";

// R4 of a trial round: reviewer agents read finished trial reports the way a
// video maker watched a take, and write down what a payer, a merchant or a
// developer would have hit. The checks only catch what someone thought to
// check; the 2026-11-06 videos found eleven problems no check covered.
//
//   npm run trial:review -- --dir trials/reports/<day>-released/woocommerce [--agent claude,codex,cursor]
//
// Each reviewer works in the report directory (read only), and its answer is
// saved there as review-<agent>.md. Reports carry the codes redacted, so no
// reviewer sees one.

const trialsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const REVIEW_PROMPT = `You are reviewing finished trials of OpenReceive, a library that lets a shop take Bitcoin (and stablecoins through a swap provider) into the merchant's own wallet. In each trial a coding agent integrated OpenReceive into a plain shop from published directions while a scripted merchant answered, then a harness checked the result. This directory holds one or more trial reports. In each run's folder:

- transcript.md: the coding agent's work, its commands and the merchant's replies
- commands.txt: every command with its exit code
- friction.md: what the coding agent said the directions got wrong or left out
- result.json: every check, PASS or FAIL, with evidence
- payer/*.txt: what each checkout screen showed a buyer, in order (and payer/*.png screenshots)
- shop.log: the shop's own log while the harness used it

Read them as three people would:
1. A first-time shopper paying on the checkout: any wording that is developer jargon or confusing, a step with no way forward, an amount that looks wrong, a wait that feels too long.
2. The merchant who asked for this: anything the agent told them that was wrong, unclear or alarming; anything they had to do that the directions could have done for them.
3. The developer reading the code and the directions: workarounds the agent needed, errors in shop.log nobody surfaced, steps that took several tries.

Do not repeat a check that already FAILED in result.json unless you add what a person would see. Do not change any file. Answer with a list of problems, most serious first, each in this form:

- **Short title.** What happened, where (file and a short quote), and what the person would see. One to four sentences.

End with a line "Nothing else found." if you looked at everything. If you found nothing, say so in one line.`;

function value(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

export function reviewersOf(spec: string | undefined): AgentName[] {
  const names = (spec ?? "claude,codex,cursor").split(",").map((name) => name.trim());
  for (const name of names) {
    if (!(name in AGENTS))
      throw new Error(`Unknown reviewer "${name}". Reviewers: claude, codex, cursor`);
  }
  return names as AgentName[];
}

/** How many run folders (a result.json each) are under a directory. */
async function runCount(directory: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === "result.json") count += 1;
    if (entry.isDirectory()) count += await runCount(path.join(directory, entry.name));
  }
  return count;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dir = value(argv, "--dir");
  if (dir === undefined || argv.includes("--help")) {
    console.log(
      "Usage: npm run trial:review -- --dir <reports directory> [--agent claude,codex,cursor]",
    );
    return;
  }
  const directory = path.resolve(dir);
  if (!directory.startsWith(path.join(trialsRoot, "reports"))) {
    throw new Error("--dir must be inside trials/reports/.");
  }
  if (!(await stat(directory)).isDirectory()) throw new Error(`${directory} is not a directory.`);
  const runs = await runCount(directory);
  if (runs === 0) throw new Error(`${directory} holds no trial report (no result.json).`);
  const reviewers = reviewersOf(value(argv, "--agent"));
  console.log(`${runs} run(s) under ${directory}; reviewers: ${reviewers.join(", ")}`);
  await Promise.all(
    reviewers.map(async (name) => {
      const agent = AGENTS[name];
      await agent.preflight();
      const response = await agent.turn({
        workspace: directory,
        prompt: REVIEW_PROMPT,
        model: name === "cursor" ? "grok-4.7-medium-fast" : undefined,
        timeoutMs: 30 * 60_000,
        env: cursorEnv(process.env),
      });
      const text = (response.lastText || response.text).trim();
      const file = path.join(directory, `review-${name}.md`);
      await writeFile(
        file,
        `# Review by ${agent.label}\n\n${text || "(no answer)"}${response.timedOut ? "\n\n(The review timed out.)" : ""}\n`,
      );
      await agent.forget(directory);
      console.log(`${name}: ${file}`);
    }),
  );
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
