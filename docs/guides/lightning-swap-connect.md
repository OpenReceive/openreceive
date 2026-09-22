# Lightning Swap Connect (LSC) URI

Lightning Swap Connect (LSC) is OpenReceive's short, server-only format for
configuring an authenticated swap API endpoint. One URI replaces a provider's
HTTPS base URL, API key, and API secret.

## Example

```text
lightning+swapconnect://swap.example/v1?key=example-key&secret=example-secret
```

The example resolves to:

| Value              | Result                     |
| ------------------ | -------------------------- |
| HTTPS API base URL | `https://swap.example/v1/` |
| API key            | `example-key`              |
| API secret         | `example-secret`           |

LSC does not replace NWC. NWC connects OpenReceive to the receive-only
Lightning wallet. LSC connects OpenReceive to an optional service that accepts
another asset and swaps it into a Lightning invoice.

## URI syntax

An LSC v0.1 URI has this form:

```text
lightning+swapconnect://host[/path]?key=KEY&secret=SECRET
```

The components are:

| Component | Required | Meaning                                         |
| --------- | -------- | ----------------------------------------------- |
| Scheme    | Yes      | Exactly `lightning+swapconnect`                 |
| Host      | Yes      | Swap provider HTTPS host                        |
| Port      | No       | Explicit HTTPS port                             |
| Path      | No       | Swap provider API base path. Defaults to `/`    |
| `key`     | Yes      | Provider API key                                |
| `secret`  | Yes      | Provider API secret                             |

The URI must not contain user information or a fragment. Each required query
parameter must appear exactly once. Unknown parameters are rejected, so a typo
cannot silently change your configuration.

LSC v0.1 defines one swap-provider API contract. OpenReceive assumes every
configured provider implements it. That is why the URI has no field for
choosing or negotiating a contract.

Query names and values use standard URI percent-encoding. Build URIs with a URL
library instead of joining strings. The OpenReceive Node package exports
`formatLscUri()` for this.

## Endpoint mapping

The custom scheme always maps to HTTPS:

```text
lightning+swapconnect://HOST[:PORT]/PATH
                         │
                         └── https://HOST[:PORT]/PATH/
```

You cannot express plain HTTP. The parsed base path always ends with a slash.
OpenReceive builds a provider identifier from the lower-case hostname, the
optional port, and the path, replacing unsupported characters with `-`. Two
configured URIs may not produce the same identifier.

## Environment variables

You configure swap providers with `LSC_URI_PRIMARY` and, optionally,
`LSC_URI_BACKUP`. While the primary answers, OpenReceive uses only the
primary. It uses the backup only when the primary is down. See
[Environment variables](environment-variables.md).

The BTCPay Server plugin reads no environment variables. You paste the primary
and backup codes into Store → OpenReceive, and the plugin keeps them in its
per-store settings ([BTCPay quickstart](quickstart-btcpay.md)). The same
primary-then-backup rule applies.

## Security requirements

An LSC URI is a bearer credential. Anyone who has it can use whatever
permissions and budget the provider gave that key.

- Keep LSC URIs on the server. Keep them out of browser bundles, logs,
  exception messages, screenshots, analytics, shell history, and committed
  files.
- Store the complete URI as one secret. Do not split it into public and secret
  parts.
- Give each application its own provider key with the smallest permissions and
  budget available.
- Rotate the key and secret if the URI is exposed.
- Redact the whole value. Redacting only `secret` still exposes the API key
  and the provider's identity.
- Do not put an LSC URI in a link, QR code, or browser address bar. Credentials
  in a URI can leak through browser history, telemetry, referrers, clipboard
  managers, and process inspection.

NWC deliberately defines a connection URI for a client and a wallet service
that use cryptographic keys. LSC just packages ordinary HTTPS API credentials.
It adds no end-to-end encryption beyond TLS, and it defines no provider
authorization handshake.
