"""OpenReceive for Python: receive-only Lightning checkout over NWC.

The kernel (money, settlement, NIP-47 normalization, the wallet walk, the
closure decision, swaps) is pure functions over dicts; the server
(`openreceive.server`) binds it to a wallet client, a price feed and a payment
repository, and `openreceive.django` / `openreceive.fastapi` mount the
framework-free handler. This module re-exports only the kernel entry points
hosts reach for directly.
"""

from openreceive._version import __version__
from openreceive.money import quote_fiat_to_msats
from openreceive.nwc.uri import NWC_CODE_HELP_URL, NwcUriParseError, parse_uri, redact_uri
from openreceive.settlement import is_settled

parse_nwc_uri = parse_uri
redact_nwc_uri = redact_uri

__all__ = [
    "NWC_CODE_HELP_URL",
    "NwcUriParseError",
    "__version__",
    "is_settled",
    "parse_nwc_uri",
    "quote_fiat_to_msats",
    "redact_nwc_uri",
]
