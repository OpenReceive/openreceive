"""Repository goldens through the mounted Django views and real ORM transactions."""

from __future__ import annotations

import json

import pytest
from django.contrib.auth.models import Group
from django.db import connection
from django.test import Client

from openreceive.django import conf
from openreceive.django.repository import DjangoPaymentRepository
from tests.server.test_http_golden import (
    GOLDEN_PATHS,
    assert_golden_value,
    assert_repository_effects,
    build_repository_app,
)

pytestmark = pytest.mark.django_db(transaction=True)
REPOSITORY_PATHS = [path for path in GOLDEN_PATHS if "repository-" in path.name]


@pytest.mark.parametrize("path", REPOSITORY_PATHS, ids=lambda path: path.stem)
def test_mounted_repository_golden(path):
    vector = json.loads(path.read_text())
    repository = DjangoPaymentRepository(clock=lambda: 1000)

    def on_paid(payment):
        # A host-owned ORM row written in the same actual database transaction.
        Group.objects.create(name=payment.reference)
        if vector["handler"] == "repository_failed_settlement":
            raise RuntimeError("host rollback fixture")

    conf._app = build_repository_app(vector, repository, on_paid)
    trigger = vector["handler"] == "repository_failed_create"
    try:
        if trigger:
            with connection.cursor() as cursor:
                if connection.vendor == "sqlite":
                    cursor.execute(
                        "CREATE TRIGGER fail_golden_attempt BEFORE INSERT ON openreceive_payments BEGIN SELECT RAISE(ABORT, 'storage fixture'); END"
                    )
                elif connection.vendor == "mysql":
                    cursor.execute(
                        "CREATE TRIGGER fail_golden_attempt BEFORE INSERT ON openreceive_payments FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'storage fixture'"
                    )
                else:
                    cursor.execute(
                        "CREATE FUNCTION fail_golden_attempt() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'storage fixture'; END; $$ LANGUAGE plpgsql"
                    )
                    cursor.execute(
                        "CREATE TRIGGER fail_golden_attempt BEFORE INSERT ON openreceive_payments FOR EACH ROW EXECUTE FUNCTION fail_golden_attempt()"
                    )
        request = vector["request"]
        response = Client().post(
            request["path"], json.dumps(request["body"]), content_type="application/json"
        )
        body = response.json()
        assert response.status_code == vector["expected"]["status"], body
        for header, value in vector["expected"]["headers"].items():
            assert_golden_value(response[header], value, f"header {header}")
        assert_golden_value(body, vector["expected"]["body"], vector["name"])
        assert_repository_effects(vector, repository, body, Group.objects.count())
    finally:
        if trigger:
            with connection.cursor() as cursor:
                if connection.vendor == "postgresql":
                    cursor.execute(
                        "DROP TRIGGER IF EXISTS fail_golden_attempt ON openreceive_payments"
                    )
                    cursor.execute("DROP FUNCTION IF EXISTS fail_golden_attempt()")
                else:
                    cursor.execute("DROP TRIGGER IF EXISTS fail_golden_attempt")
        conf.reset()
