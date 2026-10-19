import time
from types import SimpleNamespace

from odoo.exceptions import UserError, ValidationError
from odoo.tests import tagged

from openreceive.server import HookContext
from openreceive.storage import AttemptConflict, PaymentInsert, SettlementRecord

from .. import const, operations, runtime
from ..repository import OdooPaymentRepository
from .common import TEST_NWC, OpenReceiveCommon, SpendingWallet

HASH_A = "a" * 64
HASH_B = "b" * 64


def checkout(reference, payment_hash, now, expires_in=600):
    return PaymentInsert(
        reference=reference,
        payment_hash=payment_hash,
        checkout={
            "reference": reference,
            "payment_hash": payment_hash,
            "created_at": now,
            "expires_at": now + expires_in,
        },
    )


@tagged("post_install", "-at_install")
class TestOpenReceive(OpenReceiveCommon):
    def test_amount_comes_from_the_transaction(self):
        tx = self.make_transaction(12.5)
        host = runtime.OdooHost(self.database())
        self.assertEqual(
            host.amount_for(tx.reference),
            {
                "currency": "USD",
                "value": "12.50",
                "description": f"{tx.company_id.name} {tx.reference}",
            },
        )
        self.assertIsNone(host.amount_for("NOT-A-TRANSACTION"))
        tx.with_context(payment_safe_write=True)._set_done()
        self.assertIsNone(host.amount_for(tx.reference), "A paid transaction mints nothing.")

    def test_only_the_paying_session_is_authorized(self):
        tx = self.make_transaction()
        other = self.make_transaction()
        host = runtime.OdooHost(self.database())

        def allowed(session):
            request = SimpleNamespace(session=session, env=self.env)
            return host.authorize(
                HookContext(
                    action="checkout.create", request=request, resource={"reference": tx.reference}
                )
            )

        self.assertTrue(allowed({runtime.MONITORED_TX_ID_KEY: tx.id}))
        self.assertFalse(allowed({runtime.MONITORED_TX_ID_KEY: other.id}))
        self.assertFalse(allowed({}))
        no_env = SimpleNamespace(session={runtime.MONITORED_TX_ID_KEY: tx.id}, env=None)
        self.assertFalse(
            host.authorize(
                HookContext(
                    action="checkout.create", request=no_env, resource={"reference": tx.reference}
                )
            )
        )

    def test_a_settled_checkout_marks_the_transaction_done(self):
        tx = self.make_transaction(12.0)
        app = self.app()
        status, created = self.call(app, "/checkouts", {"reference": tx.reference})
        self.assertEqual(status, 201, created)
        payment = created["checkout"]
        self.assertEqual(payment["amount_msats"], 24_000_000, "$12 at the static $50,000.")
        self.assertTrue(payment["bolt11"].startswith("ln"))

        again_status, again = self.call(app, "/checkouts", {"reference": tx.reference})
        self.assertEqual(again_status, 201)
        self.assertEqual(
            again["checkout"]["payment_hash"],
            payment["payment_hash"],
            "A reload resumes the invoice.",
        )

        self.wallet.settle_invoice(payment["payment_hash"])
        # The creates above ran a scan; the gate admits the next one 3 s later.
        app.reconciler.gated_reconcile(now=int(time.time()) + 10)
        status, checked = self.call(
            app,
            "/payments/check",
            {"reference": tx.reference, "payment_hash": payment["payment_hash"]},
        )
        self.assertEqual(status, 200, checked)
        self.assertEqual(checked["status"], "settled", checked)
        tx.invalidate_recordset()
        self.assertEqual(tx.state, "done")
        self.assertEqual(tx.provider_reference, payment["payment_hash"])
        self.assertTrue(tx.is_post_processed)
        self.env.cr.execute(
            "SELECT status FROM openreceive_payments WHERE payment_hash = %s",
            [payment["payment_hash"]],
        )
        self.assertEqual(self.env.cr.fetchone()[0], "settled")

        status, refused = self.call(app, "/checkouts", {"reference": tx.reference})
        self.assertIn(status, (404, 409), refused)

    def test_settlement_is_write_once(self):
        repository = OdooPaymentRepository(self.database(), clock=lambda: 1_800_000_000)
        repository.commit_attempt(checkout("ORDER-1", HASH_A, 1_800_000_000))
        self.assertEqual(
            repository.commit_attempt(checkout("ORDER-1", HASH_A, 1_800_000_000)).payment_hash,
            HASH_A,
            "A repeated payment hash is idempotent.",
        )
        fulfilled = []
        first = repository.record_settlement(
            SettlementRecord(payment_hash=HASH_A, paid_at=1_800_000_010), fulfilled.append
        )
        second = repository.record_settlement(
            SettlementRecord(payment_hash=HASH_A, paid_at=1_800_000_020), fulfilled.append
        )
        self.assertTrue(first)
        self.assertFalse(second)
        self.assertEqual(len(fulfilled), 1)
        self.assertIs(
            fulfilled[0].connection,
            self.env.cr,
            "on_paid runs inside the settlement's transaction.",
        )
        with self.assertRaises(AttemptConflict):
            repository.commit_attempt(checkout("ORDER-1", HASH_B, 1_800_000_000))

    def test_the_reconcile_gate_admits_one_scan(self):
        repository = OdooPaymentRepository(self.database())
        claim = repository.claim_reconcile_gate(now=1_800_000_000, interval_seconds=3)
        self.assertIsNotNone(claim)
        self.assertIsNone(repository.claim_reconcile_gate(now=1_800_000_001, interval_seconds=3))
        self.assertTrue(
            repository.checkpoint_reconcile_gate(
                claim, claim["scheduler"], now=1_800_000_001, release=True
            )
        )

    def test_the_wallet_code_is_saved_only_when_receive_only(self):
        runtime.write_code(self.env.cr, const.NWC_KEY, None)
        operations.WALLET_CLIENT_FACTORY = lambda _uri: SpendingWallet()
        try:
            with self.assertRaises(UserError):
                operations.save_wallet_code(self.env, TEST_NWC)
            self.assertNotIn(const.NWC_KEY, runtime.read_codes(self.env.cr))
        finally:
            operations.WALLET_CLIENT_FACTORY = lambda _uri: type(self.wallet)()
        operations.save_wallet_code(self.env, TEST_NWC)
        self.assertEqual(runtime.read_codes(self.env.cr)[const.NWC_KEY], TEST_NWC)
        self.provider.invalidate_recordset()
        self.assertTrue(self.provider.openreceive_nwc_set)
        self.assertFalse(self.provider.openreceive_nwc_uri, "The form never shows a saved code.")

    def test_enabling_needs_a_wallet_code(self):
        runtime.write_code(self.env.cr, const.NWC_KEY, None)
        # ValidationError is a UserError.
        with self.assertRaises(UserError):
            operations.enable(self.env)
        with self.assertRaises(ValidationError):
            if "state" in self.provider._fields:
                self.provider.state = "enabled"
            else:
                self.provider.is_published = True
            self.provider.flush_recordset()

    def test_a_swap_code_renames_the_payment_method(self):
        operations.save_swap_code(
            self.env,
            const.LSC_PRIMARY_KEY,
            "lightning+swapconnect://swap.example:443/?key=k&secret=s",
        )
        self.assertEqual(self.method.name, const.PAYMENT_METHOD_SWAP_NAME)
        with self.assertRaises(UserError):
            operations.save_swap_code(self.env, const.LSC_BACKUP_KEY, "https://not-a-swap-code")
        operations.save_swap_code(self.env, const.LSC_PRIMARY_KEY, "")
        self.assertEqual(self.method.name, const.PAYMENT_METHOD_NAME)

    def test_doctor_reports_without_raising(self):
        ok, lines = operations.doctor(self.env)
        text = "\n".join(lines)
        self.assertIn("NWC_URI: present-redacted", text)
        self.assertNotIn(TEST_NWC, text)
        self.assertIn("provider: OpenReceive", text)
        self.assertIsInstance(ok, bool)
