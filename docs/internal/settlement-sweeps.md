# Settlement reconciliation

There is no OpenReceive-owned sweep database, privileged sweep route, or durable cursor. The
host selects `openreceive_payments` rows where `paid_at IS NULL` and calls
`reconcilePayments({ attempts })`; `startOpenReceiveReconciler` automates that loop.

OpenReceive scans shared creation-time ranges rather than walking wallet history once per hash.
Failed callbacks leave the attempt unsettled and are retried on the next pass or after restart.
Pending results are mutable; settled facts are final.
