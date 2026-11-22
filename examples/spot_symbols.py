"""Canonical symbol labels shared by the Python operator examples."""

import re


_SPOT_SYMBOL = re.compile(r"[-A-Za-z0-9_.$!]+(?: [-A-Za-z0-9_.$!]+)*")


def normalize_spot_symbol(value):
    """Return the uppercase ASCII label if it fits the signal contract."""
    if isinstance(value, str) and len(value) <= 16 and _SPOT_SYMBOL.fullmatch(value):
        return value.upper()
    return None
