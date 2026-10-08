# How we test platforms

Most people add OpenReceive with a coding agent: they paste our directions, or a
prompt, into Cursor, Claude Code, v0 or a similar tool. So we test it the same
way. When a framework or platform is marked **Tested** on
[openreceive.org/platforms](https://openreceive.org/platforms), an AI coding
agent has added OpenReceive to a plain app on it, from scratch, and the result
has passed every check below.

## One run

1. **A plain app.** We start from a small shop with five products and orders in
   its own database, built the usual way for that framework or platform. It has
   no OpenReceive in it.
2. **An agent and our published directions.** A coding agent gets the same
   message a merchant would send, with a link to the directions on
   openreceive.org. It works on its own; a script plays the merchant and answers
   its questions.
3. **Real wallet codes.** The merchant gives the agent a real receive-only NWC
   code and a real swap-provider code, and only when the agent asks for one. On
   a hosting platform such as Vercel, the codes are already the project's
   environment variables, and the agent must not ask for them.
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
- the agent stays inside the app: it does not clone our repository or read
  other projects;
- the agent finishes within the turn and time limits;
- on a hosting platform:
  - the payment route runs on Node, not an Edge runtime;
  - no worker or cron job was added, because settlement runs on page requests;
  - the deploy builds;
  - a buyer's order gets a real Lightning invoice;
  - a stranger asking for the same order is refused.

## What Tested means, and what it does not

- **It is dated.** Each badge shows the date and the OpenReceive release of the
  last passing run.
- **It covers the path we document.** It does not cover every configuration a
  platform allows. A custom database adapter, an Edge runtime or an unusual
  build setup is outside the test.
- **It stops at the invoice.** The run creates a real invoice but does not pay
  it. Settlement, refunds and swap recovery are covered by each library's own
  test suites, against a test wallet and real databases.
- **"Guide" means not yet tested.** A platform with a guide but no badge is
  documented, and we have not yet run it end to end.

The test code is open source, in
[`evals/directions`](https://github.com/OpenReceive/openreceive/tree/master/evals/directions)
in the OpenReceive repository.
