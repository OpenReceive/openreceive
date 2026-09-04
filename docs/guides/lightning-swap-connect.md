# Lightning Swap Connect (LSC) URI

Lightning Swap Connect is OpenReceive's compact, server-only format for
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

LSC is not an NWC replacement. NWC connects OpenReceive to the receive-only
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
| Path      | No       | Swap provider API base path; `/` is the default |
| `key`     | Yes      | Provider API key                                |
| `secret`  | Yes      | Provider API secret                             |

The URI must not contain user information or a fragment. Each required query
parameter must appear exactly once. Unknown parameters are rejected so that a
misspelling cannot silently change configuration.

LSC v0.1 defines one swap-provider API contract. Every configured provider is
assumed to implement that contract, so there is no selector or negotiation
field in the URI.

Query names and values use standard URI percent-encoding. Producers should use
a URL implementation instead of concatenating strings. The OpenReceive Node
package exports `formatLscUri()` for this purpose.

## Endpoint mapping

The custom scheme always maps to HTTPS:

```text
lightning+swapconnect://HOST[:PORT]/PATH
                         │
                         └── https://HOST[:PORT]/PATH/
```

Plain HTTP cannot be expressed. The parsed base path always has a trailing
slash. A provider identifier is derived from the lower-case hostname, optional
port, and path by replacing unsupported characters with `-`. Two configured
URIs may not derive the same identifier.

## Environment variables

Swap providers are configured with `LSC_URI_PRIMARY` and optional
`LSC_URI_BACKUP`. While the primary answers, OpenReceive uses only the
primary; the backup is consulted only when the primary is down. See
[Environment variables](environment-variables.md).

The BTCPay Server plugin reads no environment variables: the primary and
backup codes are pasted into Store → OpenReceive and kept in the plugin's
per-store settings ([BTCPay quickstart](quickstart-btcpay.md)). The same
primary-then-backup rule applies.

## Security requirements

An LSC URI is a bearer credential. Anyone who obtains it can exercise whatever
permissions and budget the provider assigned to that key.

- Keep LSC URIs on the server and out of browser bundles, logs, exception
  messages, screenshots, analytics, shell history, and committed files.
- Store the complete URI as one secret. Do not split it into public and secret
  fragments.
- Give each application a separate provider key with the smallest available
  permissions and budget.
- Rotate the key and secret if the URI is exposed.
- Redact the complete value. Redacting only `secret` still exposes the API key
  and provider identity.
- Do not place an LSC URI in a link, QR code, or browser address bar. URI
  credentials can leak through history, telemetry, referrers, clipboard
  managers, and process inspection.

NWC intentionally defines a connection URI for a client and wallet service with
cryptographic keys. LSC packages conventional HTTPS API credentials; it does
not add end-to-end encryption beyond TLS and does not define a provider
authorization handshake.
