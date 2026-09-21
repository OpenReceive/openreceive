"""Versioned, credential-free scheduler state in the existing durable gate row."""

from __future__ import annotations

import copy
import json
import uuid
from typing import Any

from openreceive.storage.repository import SchemaError, is_fresh_timestamp

MAX_CHECKPOINT_BYTES = 128 * 1024


def parse_gate(value: object) -> dict[str, Any]:
    try:
        gate = json.loads(str(value))
    except (ValueError, TypeError):
        gate = {}
    if not isinstance(gate, dict):
        gate = {}
    if int(gate.get("version", 0)) > 1:
        raise SchemaError("Unsupported reconciliation checkpoint version; upgrade OpenReceive.")
    if gate.get("version") != 1:
        # Only derived state is discarded during a coordinated engine upgrade.
        return {"scheduler": {"cursor": None, "windows": []}}
    return gate


def claim_state(
    current: dict[str, Any], now: int, interval_seconds: int, lease_seconds: int
) -> dict[str, Any] | None:
    claimed = current.get("claimed_at")
    if claimed is not None and is_fresh_timestamp(now, int(claimed), interval_seconds):
        return None
    if current.get("lease_until", 0) > now and int(current.get("claimed_at", 0)) <= now + 60:
        return None
    return {
        "version": 1,
        "claimed_at": now,
        "token": str(uuid.uuid4()),
        "lease_until": now + lease_seconds,
        "interval_seconds": interval_seconds,
        "scheduler": copy.deepcopy(current.get("scheduler", {"cursor": None, "windows": []})),
    }


def checkpoint_state(
    current: dict[str, Any],
    claim: dict[str, Any],
    scheduler: dict[str, Any],
    now: int,
    release: bool,
) -> dict[str, Any] | None:
    if current.get("token") != claim["token"] or current.get("lease_until", 0) <= now:
        return None
    state = {**current, "scheduler": scheduler}
    if release:
        state["lease_until"] = 0
    if len(scheduler.get("windows", [])) > 2 or any(
        len(w.get("attempts", [])) > 200 for w in scheduler.get("windows", [])
    ):
        raise ValueError("Reconciliation checkpoint exceeded its bounded cohort queue.")
    if len(json.dumps(state).encode()) > MAX_CHECKPOINT_BYTES:
        raise ValueError("Reconciliation checkpoint exceeded 128 KiB.")
    return state
