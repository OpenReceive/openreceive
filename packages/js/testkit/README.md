# @openreceive/testkit

Run OpenReceive's repository tests and demos without a real wallet or swap
provider. This internal package supplies deterministic fake NWC and swap
clients so the actual payment engine, database, and host hooks can be tested.
It is private and unpublished; it is not an application dependency on npm.

The test fixtures cover Lightning and optional swap flows for **USDT, USDC,
SOL, and ETH**. In a live integration, a configured provider converts the
customer's payment to **BTC over Lightning** in the merchant's wallet; asset
and network availability depends on that provider. Fakes simulate this flow
without moving funds.

## Testing your own application

Use the public [host-testing guide](../../../docs/guides/host-testing.md) for
injecting wallet and provider fakes through supported integration hooks.

## Contributing to OpenReceive

The shared [testkit contract](../../../docs/internal/testkit-contract.md)
defines fixture shapes and control routes across the engines. Run the focused
test for your change, then the required checks in [AGENTS.md](../../../AGENTS.md).
Launch demo applications and their backing services in Docker; test runners
may run on the host. This package's internal API may change between releases.
