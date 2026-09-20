"""The repository CONTRACT, run against the ORM backend. The test functions
are the SQL repository's own (tests/storage/test_sql_repository.py), collected
here a second time with this directory's `repository` / `clock` fixtures — one
set of assertions, two backends, so a rule that drifts in one implementation
fails loudly instead of as a one-stack E2E mystery. Django-only behaviour
(the ambient transaction, the migration-based schema guard) follows."""

from __future__ import annotations

import pytest
from django.db import connection, transaction

from openreceive.storage import (
    PaymentInsert,
    PaymentSettlement,
    SchemaError,
    SettlementRecord,
)
from openreceive.storage.repository import SCHEMA_VERSION_KEY
from tests.django.conftest import DjangoPaymentRepository
from tests.storage import test_sql_repository as contract

pytestmark = pytest.mark.django_db(transaction=True)

H1 = contract.H1
checkout = contract.checkout

# The shared contract, re-collected under the Django fixtures.
test_commit_then_read_back = contract.test_commit_then_read_back
test_live_same_rail_conflicts_and_near_expiry_supersedes = (
    contract.test_live_same_rail_conflicts_and_near_expiry_supersedes
)
test_settlement_is_write_once_and_fulfills_first_only = (
    contract.test_settlement_is_write_once_and_fulfills_first_only
)
test_fulfill_failure_rolls_the_settlement_back = (
    contract.test_fulfill_failure_rolls_the_settlement_back
)
test_record_reconciliation_only_touches_pending_rows = (
    contract.test_record_reconciliation_only_touches_pending_rows
)
test_reconcile_gate_is_a_durable_cas = contract.test_reconcile_gate_is_a_durable_cas
test_selection_rule_over_the_rows = contract.test_selection_rule_over_the_rows
test_rate_limit_window_counts_on_inserted_at = contract.test_rate_limit_window_counts_on_inserted_at
test_concurrent_commits_for_one_reference_serialize = (
    contract.test_concurrent_commits_for_one_reference_serialize
)
test_concurrent_settlement_fulfills_exactly_once = (
    contract.test_concurrent_settlement_fulfills_exactly_once
)


def test_on_paid_runs_inside_the_ambient_transaction_with_no_connection_handle(
    repository: DjangoPaymentRepository, clock: dict[str, int]
) -> None:
    now = clock["now"]
    repository.commit_attempt(PaymentInsert("ord-1", H1, checkout("ord-1", H1, now, now + 600)))
    seen: list[tuple[bool, object]] = []

    def fulfill(settlement: PaymentSettlement) -> None:
        # Plain ORM calls inside the hook ride the same transaction.
        seen.append((transaction.get_connection().in_atomic_block, settlement.connection))

    assert repository.record_settlement(SettlementRecord(H1, now + 10), fulfill) is True
    assert seen == [(True, None)]


def test_schema_guard_refuses_a_newer_schema_version(repository: DjangoPaymentRepository) -> None:
    from openreceive.django.models import OpenReceiveMeta

    OpenReceiveMeta.objects.update_or_create(key=SCHEMA_VERSION_KEY, defaults={"value": "99"})
    fresh = DjangoPaymentRepository()
    with pytest.raises(SchemaError, match="newer than this library"):
        fresh.list_reconcilable_attempts()
    with pytest.raises(SchemaError, match="newer than this library"):
        DjangoPaymentRepository().count_attempts_from_ip("203.0.113.9", 0)
    OpenReceiveMeta.objects.filter(key=SCHEMA_VERSION_KEY).update(value="1")


def test_schema_guard_names_the_missing_migration(repository: DjangoPaymentRepository) -> None:
    from openreceive.django.models import OpenReceiveMeta

    table = OpenReceiveMeta._meta.db_table
    with connection.schema_editor() as editor:
        editor.execute(
            f"ALTER TABLE {editor.quote_name(table)} RENAME TO {editor.quote_name(table + '_x')}"
        )
    try:
        with pytest.raises(SchemaError, match="have not been migrated"):
            DjangoPaymentRepository().list_reconcilable_attempts()
        with pytest.raises(SchemaError, match="have not been migrated"):
            DjangoPaymentRepository().count_attempts_from_ip("203.0.113.9", 0)
    finally:
        with connection.schema_editor() as editor:
            editor.execute(
                f"ALTER TABLE {editor.quote_name(table + '_x')} RENAME TO {editor.quote_name(table)}"
            )


def test_after_commit_waits_for_outer_transaction_and_disappears_on_rollback(repository, clock):
    if repository.vendor == "mysql":
        pytest.skip("MySQL explicitly rejects ambient transactions; covered by rejection test")
    now = clock["now"]
    repository.commit_attempt(
        PaymentInsert("after-commit", H1, checkout("after-commit", H1, now, now + 600))
    )
    after = []
    with pytest.raises(RuntimeError, match="rollback"):
        with transaction.atomic(using=repository.using):
            repository.record_settlement(SettlementRecord(H1, now + 10), after_commit=after.append)
            assert after == []
            raise RuntimeError("rollback")
    assert repository.find_by_payment_hash(H1).status == "pending"
    with transaction.atomic(using=repository.using):
        repository.record_settlement(SettlementRecord(H1, now + 11), after_commit=after.append)
        assert after == []
    assert len(after) == 1 and after[0].connection is None
    assert repository.find_by_payment_hash(H1).status == "settled"


def test_after_commit_inner_savepoint_rollback_drops_callback(repository, clock):
    if repository.vendor == "mysql":
        pytest.skip("MySQL explicitly rejects ambient transactions; covered by rejection test")
    now = clock["now"]
    repository.commit_attempt(
        PaymentInsert("savepoint", H1, checkout("savepoint", H1, now, now + 600))
    )
    after = []
    with transaction.atomic(using=repository.using):
        with pytest.raises(RuntimeError):
            with transaction.atomic(using=repository.using):
                repository.record_settlement(
                    SettlementRecord(H1, now + 10), after_commit=after.append
                )
                raise RuntimeError("rollback inner")
    assert after == []
    assert repository.find_by_payment_hash(H1).status == "pending"


test_reconciliation_uses_wallet_snapshot_deadline_and_keeps_deposit_reuse = (
    contract.test_reconciliation_uses_wallet_snapshot_deadline_and_keeps_deposit_reuse
)
test_attention_requires_explicit_review_and_requeue_never_settles = (
    contract.test_attention_requires_explicit_review_and_requeue_never_settles
)
test_early_closure_report_excludes_true_wallet_expiry_and_preserves_token = (
    contract.test_early_closure_report_excludes_true_wallet_expiry_and_preserves_token
)


def test_mysql_rejects_nested_reference_operation_before_acquiring_lock(repository, clock):
    if repository.vendor != "mysql":
        pytest.skip("MySQL-only connection-scoped lock restriction")
    now = clock["now"]
    repository.commit_attempt(PaymentInsert("nested", H1, checkout("nested", H1, now, now + 600)))
    with transaction.atomic(using=repository.using):
        with pytest.raises(RuntimeError, match="outermost transaction"):
            repository.record_settlement(SettlementRecord(H1, now + 10))
    assert repository.find_by_payment_hash(H1).status == "pending"


test_terminal_transition_uses_settlement_reference_lock = (
    contract.test_terminal_transition_uses_settlement_reference_lock
)


def test_after_commit_uses_configured_alias(repository, clock, django_db_blocker):
    from django.db import connections

    alias = "openreceive_commit_alias"
    connections.databases[alias] = dict(connections[repository.using].settings_dict)
    aliased = DjangoPaymentRepository(using=alias, clock=lambda: clock["now"])
    seen = []
    try:
        with django_db_blocker.unblock():
            now = clock["now"]
            aliased.commit_attempt(
                PaymentInsert("aliased", H1, checkout("aliased", H1, now, now + 600))
            )

            def after_commit(payment):
                # Independent default connection observes the committed row.
                seen.append(
                    (
                        connections[alias].in_atomic_block,
                        repository.find_by_payment_hash(H1).status,
                        payment.connection,
                    )
                )

            if repository.vendor == "mysql":
                aliased.record_settlement(SettlementRecord(H1, now + 1), after_commit=after_commit)
            else:
                with transaction.atomic(using=alias):
                    aliased.record_settlement(
                        SettlementRecord(H1, now + 1), after_commit=after_commit
                    )
                    assert seen == []
            assert seen == [(False, "settled", None)]
    finally:
        connections[alias].close()
        del connections[alias]
        del connections.databases[alias]
