# Agent trials by hand: instructions for any coding agent

Give this file to a coding agent (any model, any tool) on the machine that
runs the trial wallet. Start it with one line, for example:

```text
Read trials/by-hand.md in this repository and follow it. Your name for the results file is kimi-k3.
```

The rest of this file is written to that agent.

---

You are testing OpenReceive's published agent directions. For each shop below
you play two parts: the coding agent a merchant hired to add OpenReceive to
their shop, and that merchant answering your questions from a fixed script.
Follow the directions the way a merchant's agent would, then run the checks,
and write down everything that went wrong or was unclear. A platform you could
not finish is a useful result too. Do as many platforms as you can.

What you produce: one plain-text file at the repository root,
`zz-agent-tests-results-<your name>.txt` (format at the end). The
`zz-` prefix keeps it out of git; the maintainer reads it locally. Do not
commit or push anything.

## Ground rules

These are not negotiable. Breaking one fails the whole run.

1. **Docker on this machine only.** Never deploy anything, sign up for or log
   in to any service, or use a real wallet. The shops, the wallet and the swap
   provider all run here in Docker. The wallet's relay is a real public Nostr
   relay; that is expected.
2. **Test wallet codes only.** Never read or use the repository's `.env`,
   `.env.release`, or any other file with real codes. The only codes you use
   are the ones `prepare` writes for you (below).
3. **Never print a code.** No `cat` or `echo` of a code file or of the shop's
   `.env`, no unfiltered `grep`, no `printenv`, no code typed into a command.
   Move a code with command substitution, for example
   `printf 'NWC_URI=%s\n' "$(cat <code file>)" >> .env`. To check a code is
   set, print only names, such as `cut -d= -f1 .env`.
4. **Touch only what you created.** Never stop, remove, restart or exec into
   a container, volume or network you did not create in this run. That
   includes the trial wallet (`openreceive-trial-wallet`): other agents share
   it, and a restart changes its codes. No `docker system prune`, no
   `docker rm -f $(docker ps -aq)`, no `pkill` or `killall`.
5. **The merchant's view only.** While you integrate a shop, act as if this
   repository did not exist. Read only the directions and the pages they link
   (openreceive.org, the package registries, the GitHub release). Do not open
   or copy anything under `packages/`, `docs/`, `examples/` or `skills/`, and
   install OpenReceive only from the registries the directions name. The
   only repository files you use are this one, the `npm run trial:by-hand`
   commands, and your results file.
6. **No forcing.** No workaround flags (`--force`, `--legacy-peer-deps`,
   `--ignore-platform-reqs`, `--skip-checks`, `--no-verify`…). Never edit or
   patch OpenReceive's installed files or monkeypatch its classes. If
   something only works that way, stop that platform and record it as a
   finding.
7. **Repository untouched.** Apart from your results file, change nothing in
   this repository.

## Before you start

The `npm run trial:by-hand` commands run on this machine, not in Docker. They
need Node 22 or later (check `node --version`) and the repository's
dependencies: run `npm ci` once at the repository root. Docker runs everything
else: the shops, the wallet and the swap provider.

## The platforms

Do them in this order. Every one runs entirely in Docker, needs no account,
and has a plain "Widget Shop" with five products and no OpenReceive:

| # | `--platform` | Shop |
|---|---|---|
| 1 | `node` | Express |
| 2 | `fastify` | Fastify |
| 3 | `flask` | Flask |
| 4 | `fastapi` | FastAPI |
| 5 | `php` | plain PHP |
| 6 | `django` | Django |
| 7 | `next` | Next.js |
| 8 | `nestjs` | NestJS |
| 9 | `rails` | Rails |
| 10 | `laravel` | Laravel |
| 11 | `woocommerce` | WordPress + WooCommerce (heavy) |
| 12 | `edd` | WordPress + Easy Digital Downloads (heavy) |
| 13 | `paymenter` | Paymenter billing panel (heavy) |
| 14 | `fossbilling` | FOSSBilling billing panel (heavy) |
| 15 | `prestashop` | PrestaShop store (heavy) |

Left out on purpose: Replit, Vercel, Lovable, v0 and Supabase need an account
or a real project, BTCPay Server needs a synced Bitcoin node, and mobile apps
need a device. Do not try them.

Spend at most about 90 minutes on one platform. If you are stuck, record
where and why, mark it BLOCKED, and move on.

## One platform, step by step

### 1. Prepare the shop

From the repository root:

```sh
npm run trial:by-hand -- prepare --platform <slug> --name <your name>
```

This starts the trial wallet if it is not already running (the first start
builds images and can take several minutes). It then copies the plain shop to
a new directory under the system temp dir, wires it to the wallet, starts it,
and checks that it is plain. It prints:

- the shop directory and its URL;
- the `COMPOSE_FILE` line to export before any `docker compose` command for
  this shop (it adds the wallet's network and certificate authority, which a
  real merchant's machine would not need: treat it as part of the
  environment, not as something the directions asked for);
- the directions URL and the **merchant prompt**, the merchant's first message
  to you;
- the doctor command, where the codes go, and the two code files (`nwc`,
  `lsc`) that stand in for what the merchant pastes;
- the command that reads an order's status inside the shop.

Copy that block into your notes. If `prepare` fails, record the platform as
BLOCKED (infrastructure) with the error, and move on.

### 2. Integrate, as the merchant's agent

Work inside the shop directory. Act on the merchant prompt: fetch the
directions the way they say (they ask for a full download) and follow them
from Step 0. Use the shop's own Docker Compose setup for everything that runs
the app.

When the directions tell you to ask the merchant something, write the exact
question into your notes (it is graded), then answer it from this script:

| You ask for… | The merchant answers |
|---|---|
| the NWC code | pastes it: copy the `nwc` file into the place the directions name, without printing it |
| the LSC (swap) code, or whether they want stablecoins | "Yes, stablecoins too," then pastes the `lsc` file the same way |
| a backup LSC code | "I don't have a backup code." |
| that they run a command or edit a file themselves | "I'd rather not run commands or edit files. Can you do it?" Record this: directions must not hand work to the merchant. |
| anything else | "Yes, go ahead." |

Copying a code from a file instead of the chat is the one place you depart
from the directions. Everything else in Step 0 still applies: ask for the NWC
code first, one question per message, and start the quickstart only once the
codes are saved.

Keep a timestamped log as you go: each step of the directions you did, each
command that failed (its exit code and the one to three output lines that
matter, with codes redacted), and every place where you had to guess,
improvise or leave the directions. Run the doctor the directions name until
it is clean, or until you cannot make it clean.

End the integration the way the directions say to end it, with your closing
message to the merchant. Copy that message verbatim into your notes.

### 3. Check it

```sh
npm run trial:by-hand -- check --shop <shop directory>
```

This runs the same live checks an automated trial runs. A buyer orders
through the shop's own form and gets a real Lightning invoice. A stranger
asking for that order is refused. Four back-to-back status checks scan the
wallet at most once. The wallet then pays the invoice, the checkout must see
it settled, and the shop's own order must turn paid. It also checks that the
checkout offers swap methods, and that no code ended up in a git-tracked
file. Paste every PASS/FAIL line into your results. A failure prints the
shop's log; quote the lines that explain it.

WooCommerce has no scripted live checks. Instead, run its doctor, and open
the shop URL in a browser if you have one: add a product to the cart, pick
OpenReceive at checkout and confirm a Lightning QR appears.

If you have a browser tool, also do this on any shop: open the order page,
pick Bitcoin and see a QR, pick USDT on Solana and see a deposit address,
then reload the page and see the same checkout come back. Note how long each
step took.

Do not fix the shop after `check` to make it pass. If you fix something, say
so, and run `check` again; report both results.

### 4. Clean up

```sh
npm run trial:by-hand -- stop --shop <shop directory>
```

This removes the shop's containers, volumes, directory and code files. It
never touches the wallet.

## Grade yourself honestly

For each platform, answer yes or no, with a quote or command as evidence:

- Asked for the NWC code first, and one question per message.
- Walked through getting an LSC code without a yes/no question first.
- Never asked the merchant to run a command or edit a file.
- Never printed a code, in a command or its output.
- No workaround flags, no edits to OpenReceive's installed files.
- Stayed in the shop directory and on the directions' pages.
- The doctor ran, and its last run was clean.
- The closing message says "Setup is finished", has at most five lines,
  asks nothing, and does not call any coin unavailable.

## The results file

Write `zz-agent-tests-results-<your name>.txt` at the repository root, and
keep it updated as you go, so a run that stops early still leaves results. If
the file exists from an earlier run, add `-2`, `-3`… to the name. Use plain
text, with this shape:

```text
OpenReceive agent trials by hand
Agent/model:        <name and version, and the tool you ran in>
Date:               <YYYY-MM-DD>
Repository commit:  <git rev-parse --short HEAD>

SUMMARY
platform     result    minutes  directions version  main problem
node         PASS      24       0.4.26              -
fastify      FAIL      41       0.4.26              doctor: ...
...

TOP PROBLEMS ACROSS PLATFORMS
1. <the problem, which platforms, the directions line it comes from, a suggested fix>
...

=== <platform> ===
Result:             PASS | FAIL (which checks) | BLOCKED (where) | SKIPPED (why)
Directions:         <URL>, "These directions describe OpenReceive x.y.z", sha256 <first 12 hex>
Shop:               <shop directory>
Minutes:            <from prepare to check>
Questions asked:    <each question, verbatim, in order>
Log:                <timestamped steps, failed commands, deviations>
Doctor:             <last run: command, exit code, its output with codes redacted>
Closing message:    <verbatim>
Check output:       <every PASS/FAIL line>
Self-grade:         <the eight answers above>
Findings:           <each one: what happened, the directions line quoted, a suggested fix>
Directions rating:  <1-5, and one sentence why>
```

Findings matter most. Report anything a merchant's agent would trip on:
a wrong or missing step, a command that fails as written, an instruction that
contradicts the shop or another instruction, a version or package name that
does not resolve, a slow page, a confusing error from OpenReceive itself, and
anything you had to work out for yourself. Quote the directions line each
time. Write what happened, not what you think the maintainer wants to read.
