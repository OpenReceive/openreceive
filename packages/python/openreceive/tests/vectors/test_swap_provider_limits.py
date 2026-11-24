"""Only FixedFloat's own host is counted locally: the profile numbers, the
host that picks each profile, and every guard scenario of the shared family,
run through the production guard."""

from dataclasses import asdict
from typing import Any

import pytest

from openreceive.swap import budget
from tests.conftest import load_vector

VECTOR = load_vector("swap-provider-limits.json")

PROFILES = {
    "fixedfloat": budget.FIXEDFLOAT_LIMITS,
    "provider-only": budget.PROVIDER_ONLY_LIMITS,
}


def test_the_window_and_the_profile_numbers() -> None:
    assert budget.WINDOW_SECONDS == VECTOR["window_seconds"]
    assert sorted(VECTOR["profiles"]) == sorted(PROFILES)
    for name, expected in VECTOR["profiles"].items():
        limits = asdict(PROFILES[name])
        assert limits.pop("profile") == name
        assert limits == expected, name


@pytest.mark.parametrize("item", VECTOR["hosts"], ids=lambda item: item["base_url"])
def test_the_host_picks_the_profile(item: dict[str, Any]) -> None:
    assert budget.limits_for_base_url(item["base_url"]).profile == item["profile"]


@pytest.mark.parametrize("scenario", VECTOR["scenarios"], ids=lambda scenario: scenario["name"])
def test_guard_scenario(scenario: dict[str, Any]) -> None:
    clock = {"now": scenario["steps"][0]["at"]}
    guard = budget.SwapProviderWeightBudget(
        "vector", lambda: clock["now"], PROFILES[scenario["profile"]]
    )
    for index, step in enumerate(scenario["steps"], start=1):
        clock["now"] = step["at"]
        label = f"step {index} ({step['op']} {step['path']} at {step['at']})"
        for _ in range(step.get("repeat", 1)):
            if step["op"] == "rate_limited":
                guard.mark_rate_limited(
                    path=step["path"], retry_after_seconds=step.get("retry_after")
                )
                continue
            ask = guard.assert_available if step["op"] == "check" else guard.reserve
            try:
                ask(step["path"])
                result, until = "ok", None
            except budget.WeightBudgetError as error:
                result, until = error.denial["reason"], error.denial.get("backoff_until")
            assert result == step["expect"], label
            if "backoff_until" in step:
                assert until == step["backoff_until"], label
