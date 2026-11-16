"""Client-IP bucketing shared by rate limiting and attempt-row stamping; the
same input string produces the same bucket in every engine. IPv4-mapped IPv6
collapses to the IPv4; IPv6 buckets to its /64 (privacy extensions rotate the
low 64 bits); IPv4 and already-bucketed values pass through; unparsable input
passes through as-is so an odd value still gets SOME consistent bucket."""

from __future__ import annotations

import re


def attributed(raw: object) -> str | None:
    """No attributable IP stays None (the limiter fails open)."""
    value = str(raw if raw is not None else "")
    if not value.strip():
        return None
    return bucket(value)


def bucket(ip: object) -> str:
    value = str(ip if ip is not None else "").strip().lower()
    if value.startswith("::ffff:") and "." in value:
        value = value[len("::ffff:") :]
    if ":" not in value:
        return value
    if value.endswith("/64"):
        return value
    address = value.split("%", 1)[0]
    hextets = _expand_ipv6(address)
    if hextets is None:
        return value
    return ":".join(hextets[:4]) + "::/64"


def is_payer_address(value: object) -> bool:
    """Whether the limiter may count this client value as one payer.

    False for an IP address no payer on the internet can have: loopback,
    private (RFC 1918), carrier-shared (100.64.0.0/10), link-local, the
    unspecified address, and their IPv6 counterparts (::1, fc00::/7,
    fe80::/10). A server sees one of those only when the request came from its
    own proxy or network, so the address stands for every payer at once.

    True for every other IP, and for a value that is not an IP at all: a host
    that passes its own identifier (an account id, a session key) chose it
    deliberately. Accepts raw addresses and the buckets `bucket` returns."""
    address = str(value if value is not None else "").strip().lower()
    if address.startswith("::ffff:") and "." in address:
        address = address[len("::ffff:") :]
    if ":" not in address:
        octets = _parse_ipv4(address)
        if octets is None:
            return True
        first, second = octets[0], octets[1]
        return not (
            first in (0, 10, 127)
            or (first == 100 and 64 <= second <= 127)
            or (first == 169 and second == 254)
            or (first == 172 and 16 <= second <= 31)
            or (first == 192 and second == 168)
        )
    hextets = _expand_ipv6(address.split("%", 1)[0].removesuffix("/64"))
    if hextets is None:
        return True
    # :: and ::1 (a /64 bucket of either is all zeros in its first four groups).
    if all(group == "0" for group in hextets[:7]) and hextets[7] in ("0", "1"):
        return False
    leading = int(hextets[0], 16)
    return not ((leading & 0xFE00) == 0xFC00 or (leading & 0xFFC0) == 0xFE80)


def _parse_ipv4(value: str) -> list[int] | None:
    if re.fullmatch(r"[0-9]{1,3}(\.[0-9]{1,3}){3}", value) is None:
        return None
    octets = [int(octet, 10) for octet in value.split(".")]
    return None if any(octet > 255 for octet in octets) else octets


def _expand_ipv6(value: str) -> list[str] | None:
    parts = value.split("::")
    if len(parts) > 2 or not value:
        return None
    head = _hextets_of(parts[0])
    tail = _hextets_of(parts[1]) if len(parts) == 2 else []
    if head is None or tail is None:
        return None
    if len(parts) == 1:
        return head if len(head) == 8 else None
    missing = 8 - len(head) - len(tail)
    if missing < 1:
        return None
    return head + ["0"] * missing + tail


def _hextets_of(segment: str) -> list[str] | None:
    if segment == "":
        return []
    groups: list[str] = []
    for group in segment.split(":"):
        if re.fullmatch(r"[0-9a-f]{1,4}", group):
            groups.append(re.sub(r"\A0+(?=.)", "", group))
        elif re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", group):
            octets = [int(octet, 10) for octet in group.split(".")]
            if any(octet > 255 for octet in octets):
                return None
            # Embedded IPv4 tail expands to two hextets.
            groups.append(format((octets[0] << 8) | octets[1], "x"))
            groups.append(format((octets[2] << 8) | octets[3], "x"))
        else:
            return None
    return groups
