"""Translate an approved broker strategy's position transition into one spot signal."""

from decimal import Decimal, InvalidOperation
from typing import Mapping

from signal_http_client import prepare_signal


def _spot_position(rows, instrument, fields, buy, sell):
    if type(rows) not in (list, tuple) or not isinstance(instrument, str) or not instrument:
        raise ValueError("Provide a successful position snapshot for one instrument.")
    if buy is None or sell is None or buy == sell:
        raise ValueError("Provide distinct broker direction constants.")

    for row in rows:
        try:
            symbol, direction, quantity = fields(row)
        except (AttributeError, KeyError, TypeError):
            raise ValueError("The broker position is incomplete.") from None
        if symbol != instrument:
            raise ValueError("The snapshot contains a different instrument.")
        if direction == sell:
            raise ValueError("Short broker positions require operator review.")
        if direction != buy or type(direction) is bool:
            raise ValueError("Unrecognized broker position direction.")
        if type(quantity) not in (str, int, float, Decimal):
            raise ValueError("The broker quantity is invalid.")
        try:
            quantity_text = str(quantity)
            if len(quantity_text) > 128:
                raise ValueError("The broker quantity is too long.")
            value = Decimal(quantity_text)
        except (InvalidOperation, ValueError):
            raise ValueError("The broker quantity is invalid.") from None
        if not value.is_finite() or value <= 0:
            raise ValueError("A broker long needs a positive, finite quantity.")
    return "long" if rows else "flat"


def alpaca_position(positions, instrument):
    """Read scoped Alpaca Position objects from a successful account snapshot."""
    return _spot_position(positions, instrument, lambda row: (row.symbol, row.side, row.qty), "long", "short")


def mt5_position(positions, instrument, *, buy, sell):
    """Read scoped MetaTrader 5 position tuples using the terminal's direction constants."""
    return _spot_position(positions, instrument, lambda row: (row.symbol, row.type, row.volume), buy, sell)


def ctrader_position(positions, instrument, *, buy, sell):
    """Read scoped cTrader Algo positions using its TradeType values."""
    return _spot_position(positions, instrument, lambda row: (row.SymbolName, row.TradeType, row.VolumeInUnits), buy, sell)


def prepare_broker_transition(instrument: str, symbol_map: Mapping[str, str], *, previous: str,
                              current: str, signal_id: str, sequence: int, target_bps: int,
                              expires_at_ms: int) -> bytes | None:
    """Build a new signal only when the last confirmed spot state needs to change."""
    if previous not in ("flat", "long") or current not in ("flat", "long"):
        raise ValueError("Establish the previous and current spot states before forwarding.")
    if previous == current:
        return None
    return prepare_signal(instrument, symbol_map, signal_id=signal_id, sequence=sequence,
                          side=current, target_bps=target_bps if current == "long" else 0,
                          expires_at_ms=expires_at_ms)
