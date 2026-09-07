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
    finally:
        with connection.schema_editor() as editor:
            editor.execute(
                f"ALTER TABLE {editor.quote_name(table + '_x')} RENAME TO {editor.quote_name(table)}"
            )
