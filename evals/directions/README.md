# Directions eval

On-demand check of what a coding agent does with a published OpenReceive directions file. It is not part of CI. Cursor follows the directions in a disposable copy of the shop, and the harness answers as the merchant, pasting live codes from the repo-root `.env` when asked. A run spends model tokens and takes several minutes. Bitcoin is the required payment; a configured swap provider can also convert USDT, USDC, SOL, and ETH into BTC over Lightning in the merchant's wallet. Asset and network availability depends on the provider.

## One shop

```sh
npm run eval:directions -- --platform woocommerce --smoke
```

This copies `platforms/woocommerce/fixture` to a fresh directory, starts stock WordPress, WordPress CLI, and MySQL, seeds five products, and checks:

- the documented `docker compose run --rm -T cli wp` command works
- GMP is missing, which is what the directions tell the agent to fix
- OpenReceive is not installed and no wallet code is in the environment

The directory name is the Compose project name, so the stack has its own network, volumes, and published port.

## Several at once

```sh
npm run eval:directions -- --platform woocommerce --smoke --runs 2 --parallel 2
```

`--parallel` is how many smoke runs are in flight. WordPress is heavy, so at most two of those stacks run together even if `--parallel` is higher. A live run refuses `--parallel` above 1. `--keep` leaves the containers up.

## What the agent did

```sh
npm run eval:directions -- --platform woocommerce --runs 1 --parallel 1 \
  --directions-url https://raw.githubusercontent.com/OpenReceive/openreceive/v0.4.16/docs/agents/woocommerce.md
```

That URL is the 0.4.16 directions, which the dry run saw fail. To test this working tree instead, serve its directions. Wired shops besides WooCommerce: Express (`node`), Fastify, Next.js, Rails, Django, and FastAPI. None of them include OpenReceive.

```sh
npm run eval:directions -- --platform django --smoke
npm run eval:directions -- --platform fastapi --smoke
npm run eval:directions -- --platform fastapi --serve-directions
```

The default URL is the live `https://openreceive.org/agent-directions/<slug>.md`. The agent is Cursor (`agent status` must show a login). It runs on the host with its workspace set to the shop copy, because the directions tell it to run `docker compose`.

`NWC_URI` and `LSC_URI_PRIMARY` are read from the repo-root `.env` when the eval starts. The merchant pastes each one only after the agent asks for that code. `LSC_URI_BACKUP` is pasted only when the agent asks for a backup and that key is set. The values are not placed in the Cursor process environment. A live run uses one wallet, so `--parallel` must be 1. WooCommerce allows 30 turns: the 0.4.16 run used 20, and a real swap quote needs the extra room.

Exit 0 when every blocker passed, 1 when a directions check failed, 2 when Docker, the Cursor CLI, or a missing code failed.

Reports land in `evals/directions/reports/` and are not committed. `summary.md` lists blockers with the quoted line. `transcript.md` has the codes replaced by `<NWC>` and `<LSC>`.

## Passed

A platform is listed here after one live run exits 0. The report itself stays gitignored.

| Platform | Date | Release |
| --- | --- | --- |
| WooCommerce | 2026-10-06 | 0.4.18 |
| Node | 2026-10-06 | 0.4.18 |
| Fastify | 2026-10-06 | 0.4.18 |
| Next.js | 2026-10-06 | 0.4.18 |
| Rails | 2026-10-06 | 0.4.18 |
| Django | 2026-10-06 | 0.4.18 |
| FastAPI | 2026-10-06 | 0.4.18 |
