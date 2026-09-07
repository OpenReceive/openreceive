# openreceive

Receive-only Lightning checkout for Python hosts, over Nostr Wallet Connect.
One distribution with framework extras:

```sh
pip install "openreceive[django]"    # Django >= 5.2
pip install "openreceive[fastapi]"   # FastAPI >= 0.115 (sync SQLAlchemy engine for the two tables)
pip install "openreceive[sqlalchemy]"  # plain hosts: the handler + the SQL repository
```

The package is engine #5 of the OpenReceive monorepo and reproduces the shared
money, settlement, NIP-47 paging, swap-provider and HTTP behavior pinned by
`spec/test-vectors/` (`tools/conformance/python-crosslang.py`). The host owns
orders, prices and fulfillment; OpenReceive owns the `openreceive_payments` /
`openreceive_meta` rows inside the host's database, the per-reference lock,
write-once settlement and the reconciliation state machine.

Layout:

- `openreceive` — kernel: `money`, `settlement`, `nwc` (URI, info, requests,
  errors, the `ReceiveNwcClient` protocol and the production client),
  `payments` (wallet walk, closure decision), `swap`, `rates`.
- `openreceive.storage` — the `PaymentRepository` protocol, the SQLAlchemy
  Core repository (`SqlPaymentRepository`, `payments_schema_sql(dialect)`).
- `openreceive.server` — `Service`, the framework-free `RequestHandler`
  (request → status/body/headers), `OpenReceiveApp` (handler + repository +
  the gated opportunistic reconcile), notifications worker, doctor, `Host`.
- `openreceive.testing` — `FakeWallet`, `FakeSwapProvider` and the testkit
  fixtures every engine shares (`docs/internal/testkit-contract.md`).

Documentation: https://openreceive.org/guides — quickstarts for Django and
FastAPI, the storage guide, and the host testing guide.

Receive-only NWC codes must never reach browsers, logs or tests. `NWC_URI`,
`LSC_URI_PRIMARY` and `LSC_URI_BACKUP` are read from the process environment.
