# Using OpenReceive with coding agents

OpenReceive publishes machine-readable specifications and installable agent
skills, so a coding agent can add Bitcoin Lightning checkout to your
application — or debug one — without guessing.

## Building an integration?

Install the **integrate-openreceive** skill (it detects your stack and carries
the full quickstart), or paste the one-prompt agent directions:

- Claude Code: `/plugin marketplace add OpenReceive/openreceive`, then
  `/plugin install openreceive`
- Skills CLI (Codex, Cursor, and other SKILL.md-compatible tools):
  `npx skills add OpenReceive/openreceive`
- GitHub Copilot discovers the same skills from the repository's
  `.agents/skills/` directory automatically.
- No installer? Copy the agent directions for your stack and paste them into
  your agent: [Node](https://openreceive.org/agent-directions/node.md) ·
  [Rails](https://openreceive.org/agent-directions/rails.md) ·
  [BTCPay Server](https://openreceive.org/agent-directions/btcpay.md). Each
  is self-contained, quickstart included.

Every `@openreceive/*` npm package and OpenReceive gem also ships the skills in
its own `skills/` directory, so an agent working in a project that already
installed OpenReceive finds them without the network.

A **debug-openreceive-payment** skill ships alongside: boot failures, 403/404/
409 semantics, settlement timing, swap refunds, each with its fix.

## Working on OpenReceive itself?

Read
[AGENTS.md](https://github.com/OpenReceive/openreceive/blob/master/AGENTS.md)
in the repository — the architectural invariants a change must not violate.

## Generating an HTTP client, or verifying routes?

Use the normative OpenAPI contract:
[https://openreceive.org/openapi.yaml](https://openreceive.org/openapi.yaml).
It is the exact `spec/openapi/openreceive-http.v1.yaml` file from the
repository — the same contract the shipped adapters and the Rails engine are
tested against.

## Giving an agent documentation context?

Start from [https://openreceive.org/llms.txt](https://openreceive.org/llms.txt)
— every guide as raw markdown, one fetch away. Any guide page is also
available as markdown by appending `.md` to its URL.

Questions, or a problem with the library itself:
[https://openreceive.org/contact](https://openreceive.org/contact)
