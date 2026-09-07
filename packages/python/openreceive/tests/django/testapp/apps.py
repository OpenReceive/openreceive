from django.apps import AppConfig


class TestAppConfig(AppConfig):
    """A stand-in for the host's own app: `openreceive_install testapp` needs a
    label that resolves to a directory."""

    name = "tests.django.testapp"
    label = "testapp"
