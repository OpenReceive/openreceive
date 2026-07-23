# Lightning Swap Connect (LSC) URI

Lightning Swap Connect is OpenReceive's compact, server-only format for
configuring an authenticated swap API endpoint. One URI replaces a provider's
HTTPS base URL, API key, and API secret.

LSC is experimental in OpenReceive v0.1. The `lightning+swapconnect` scheme is
not registered with IANA and must not be treated as an interoperable standard
outside software that explicitly implements this document.

## Example

```text
lightning+swapconnect://swap.example/v1?key=example-key&secret=example-secret
```

The example resolves to:

| Value | Result |
| --- | --- |
| HTTPS API base URL | `https://swap.example/v1/` |
| API key | `example-key` |
| API secret | `example-secret` |

LSC is not an NWC replacement. NWC connects OpenReceive to the receive-only
Lightning wallet. LSC connects OpenReceive to an optional service that accepts
another asset and swaps it into a Lightning invoice.

## URI syntax

An LSC v0.1 URI has this form:

```text
lightning+swapconnect://host[/path]?key=KEY&secret=SECRET
```

The components are:

| Component | Required | Meaning |
| --- | --- | --- |
| Scheme | Yes | Exactly `lightning+swapconnect` |
| Host | Yes | Swap provider HTTPS host |
| Port | No | Explicit HTTPS port |
| Path | No | Swap provider API base path; `/` is the default |
| `key` | Yes | Provider API key |
| `secret` | Yes | Provider API secret |

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

OpenReceive reads a primary LSC connection and an optional backup, in that
priority order:

```dotenv
LSC_URI_PRIMARY=lightning+swapconnect://primary.example/?key=...&secret=...
LSC_URI_BACKUP=lightning+swapconnect://backup.example/?key=...&secret=...
```

An empty connection is ignored. The environment contains secrets only:

```dotenv
NWC_URI=nostr+walletconnect://...
LSC_URI_PRIMARY=lightning+swapconnect://...
LSC_URI_BACKUP=
```

Currencies, logging, route prefixes, callbacks, and other ordinary application
settings do not belong in these variables. Put those in the host framework's
normal tracked configuration: a Node configuration module or a Rails
initializer.

The OpenReceive libraries read `process.env` or `ENV`; they do not find or load
a `.env` file themselves. Application entry points may load one for local
development. Production should supply the same variables through its secret
manager or process environment.

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

## Compatibility and registration

The syntax follows the generic URI model in
[RFC 3986](https://www.rfc-editor.org/rfc/rfc3986). Custom scheme names have
registration and collision considerations described by
[RFC 7595](https://www.rfc-editor.org/rfc/rfc7595). NWC's established URI shape
is documented by [NIP-47](https://nips.nostr.com/47).

Implementations claiming LSC v0.1 compatibility must pass
[`spec/test-vectors/lsc-uri.json`](../../spec/test-vectors/lsc-uri.json).
