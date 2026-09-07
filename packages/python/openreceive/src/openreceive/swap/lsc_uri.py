"""`lightning+swapconnect://` connection URIs (`lsc-uri` vectors). Twin of
Ruby `OpenReceive::Server::LscUri`."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any
from urllib.parse import parse_qsl, urlsplit

SCHEME = "lightning+swapconnect"
ENV_NAMES = ("LSC_URI_PRIMARY", "LSC_URI_BACKUP")
QUERY_PARAMETERS = ("key", "secret")
MAX_URI_LENGTH = 8192
MAX_CREDENTIAL_LENGTH = 2048
_BAD_PERCENT = re.compile(r"%(?![0-9a-fA-F]{2})")


class LscUriError(ValueError):
    pass


def parse(value: object) -> dict[str, Any]:
    text = _credential(value, "LSC URI", MAX_URI_LENGTH)
    try:
        parts = urlsplit(text)
        hostname = parts.hostname
        port = parts.port
    except ValueError:
        raise LscUriError("LSC URI is not a valid absolute URI.")
    if parts.scheme != SCHEME:
        raise LscUriError(f"LSC URI must use {SCHEME}://.")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise LscUriError("LSC URI must not use URI userinfo.")
    if not hostname:
        raise LscUriError("LSC URI requires a provider hostname.")
    if parts.fragment or "#" in text:
        raise LscUriError("LSC URI must not contain a fragment.")
    if _BAD_PERCENT.search(parts.query):
        raise LscUriError("LSC URI query encoding is invalid.")
    pairs = parse_qsl(parts.query, keep_blank_values=True, strict_parsing=False)
    for name, _ in pairs:
        if name not in QUERY_PARAMETERS:
            raise LscUriError("LSC URI contains an unsupported query parameter.")
    key = _credential(_single(pairs, "key"), "LSC URI key", MAX_CREDENTIAL_LENGTH)
    secret = _credential(_single(pairs, "secret"), "LSC URI secret", MAX_CREDENTIAL_LENGTH)
    path = _normalize_path(parts.path)
    port_text = "" if port is None else f":{port}"
    return {
        "uri_protocol": f"{SCHEME}:",
        "base_url": f"https://{hostname}{port_text}{path}",
        "provider_id": _provider_id(hostname, port, parts.path),
        "key": key,
        "secret": secret,
    }


def read_environment(env: Mapping[str, str]) -> list[dict[str, Any]]:
    """LSC_URI_PRIMARY first, LSC_URI_BACKUP second — the failover order."""
    connections: list[dict[str, Any]] = []
    seen: set[str] = set()
    for name in ENV_NAMES:
        value = (env.get(name) or "").strip()
        if not value:
            continue
        try:
            connection = parse(value)
            if connection["provider_id"] in seen:
                raise LscUriError(f"{name} duplicates another LSC provider id.")
        except LscUriError as error:
            raise LscUriError(f"{name} is invalid: {error}") from None
        seen.add(connection["provider_id"])
        connections.append(connection)
    return connections


def _single(pairs: list[tuple[str, str]], name: str) -> str:
    values = [value for key, value in pairs if key == name]
    if len(values) != 1:
        raise LscUriError(f"LSC URI requires exactly one {name} parameter.")
    return values[0]


def _credential(value: object, label: str, maximum_length: int) -> str:
    normalized = str(value if value is not None else "").strip()
    if not normalized:
        raise LscUriError(f"{label} must not be empty.")
    if len(normalized) > maximum_length:
        raise LscUriError(f"{label} is too long.")
    return normalized


def _normalize_path(path: str) -> str:
    if not path or path == "/":
        return "/"
    return path if path.endswith("/") else f"{path}/"


def _provider_id(hostname: str, port: int | None, path: str) -> str:
    segments = "-".join(segment for segment in path.split("/") if segment)
    raw = f"{hostname}{'' if port is None else f'-{port}'}{f'-{segments}' if segments else ''}"
    raw = re.sub(r"[^a-z0-9_-]+", "-", raw.lower()).strip("-")[:64]
    if not raw:
        raise LscUriError("LSC URI could not derive a provider id.")
    return raw
