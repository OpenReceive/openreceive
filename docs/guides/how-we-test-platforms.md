# How we test platforms

Most people add OpenReceive with a coding agent: they paste our directions, or a
prompt, into Cursor, Claude Code, v0 or a similar tool. So we test it the same
way. When a framework or platform is marked **Tested** on
[openreceive.org/platforms](https://openreceive.org/platforms), an AI coding
agent has added OpenReceive to a plain app on it, from scratch, in three
trials in a row, and every trial passed every check below. We record the
coding agent and model that ran each platform's trials, such as Cursor with
Grok or Claude Code.

## One trial

1. **A plain app.** We start from a small shop with five products and orders in
   its own database, built the usual way for that framework or platform, on its
   current major version. It has no OpenReceive in it. For a database such as
   Supabase, the shop's data is already in a real project there. For an AI
   builder whose own agent we do not drive, such as Lovable or Bolt, the shop
   is built the way that builder builds one, and runs on a local copy of its
   stack: for Bolt, a Vite React app on Supabase's own Postgres, Auth, API
   server and Edge Functions runtime.
2. **An agent and our published directions.** A coding agent gets the same
   message a merchant would send, with a link to the directions on
   openreceive.org. It works on its own; a script plays the merchant and answers
   its questions.
3. **Wallet codes for a test wallet.** The merchant gives the agent a
   receive-only NWC code and a swap-provider code, and only when the agent asks
   for one. They belong to a test wallet and a test swap provider that speak
   the same protocols as real ones, over a real TLS relay, so the trial can
   also pay an invoice. On a hosting platform such as Vercel, the codes are
   already the project's environment variables, and the agent must not ask for
   them.
4. **A real deploy.** For a hosting platform, the finished app is deployed to
   that platform and tested on its live URL. On an AI builder that hosts apps,
   such as Replit, the platform's own agent does the work: we send it the
   prompt from the guide, word for word, and publish the result.

## What a pass requires

Every check must pass:

- the agent asks for each code in the right order, or not at all when the
  platform already holds them;
- no code appears in a command line, an agent message, or a file that git
  tracks;
- the agent does the work itself, and never asks the merchant to run commands or
  edit files;
- every OpenReceive setup command succeeds as documented, with no flag that
  skips a failure, and the last doctor run is clean (Lovable's agent has no
  terminal, so its trials have no doctor run);
- the agent stays inside the app: it does not clone our repository or read
  other projects, and it never stops other programs' servers;
- the agent finishes within the turn and time limits, with a short hand-over
  that starts "Setup is finished" and asks the merchant nothing;
- on a framework app, the app is still running at the end: a buyer's order gets
  a Lightning invoice, reloading the order page resumes that same invoice,
  another visitor asking for that order is refused, and once the test wallet
  pays the invoice, the shop marks its own order paid;
- on a framework app with the swap code, the checkout offers the test
  provider's coins, and a buyer pays a second order by swap, USDT on Solana:
  the test provider completes the swap, its Lightning invoice settles in the
  test wallet, and the shop marks that order paid too;
- on a builder whose payment routes are a server function on another site
  than its pages, such as Bolt: in a real browser, the buyer signs up and buys
  through the shop's own pages, served under the builder's domain, and the
  order page's checkout gets its invoice from the function; another signed-in
  user, and the project's public key with no user, are refused; and an order
  the browser writes at a lower price is refused or charged the catalog price;
- on a database platform such as Supabase, OpenReceive's tables end up closed
  to the platform's public API, which every visitor's browser can reach;
- on a hosting platform:
  - the payment route runs on Node, not an Edge runtime;
  - no worker or cron job was added, because settlement runs on page requests;
  - the deploy builds;
  - a buyer's order gets a real Lightning invoice;
  - a stranger asking for the same order is refused.

## What Tested means, and what it does not

- **It is dated.** Each badge shows the date and the OpenReceive release of the
  last passing trials.
- **It covers the path we document.** It does not cover every configuration a
  platform allows. A custom database adapter, an Edge runtime or an unusual
  build setup is outside the test.
- **It pays twice, from a test wallet.** The trial checks that a paid
  Lightning invoice and a completed swap each reach the shop's own order. The
  test swap provider moves no money: it completes the swap when the trial says
  so. Refunds, swap recovery and every settlement edge case are covered by
  each library's own test suites.
- **The swap and reload checks are newer than some badges.** They joined on
  2026-10-14. A badge earned before them stands until that platform's next
  trials.
- **"Guide" means not yet tested.** A platform with a guide but no badge is
  documented, and we have not yet run it end to end.

The test code is open source, in
[`trials`](https://github.com/OpenReceive/openreceive/tree/master/trials)
in the OpenReceive repository.
