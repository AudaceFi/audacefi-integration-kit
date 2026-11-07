import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples"))
from broker_position_signals import alpaca_position, ctrader_position, mt5_position, prepare_broker_transition


INSTRUMENT = "strategy-instrument"
SPOT_MAP = {INSTRUMENT: "PILOT"}
SIGNAL = {"signal_id": "position-event-01", "sequence": 1, "target_bps": 2, "expires_at_ms": 1_800_000_000_000}


class BrokerPositionSignalTest(unittest.TestCase):
    def test_broker_shapes_produce_the_same_spot_state(self):
        snapshots = (
            alpaca_position([SimpleNamespace(symbol=INSTRUMENT, side="long", qty="0.25")], INSTRUMENT),
            mt5_position((SimpleNamespace(symbol=INSTRUMENT, type=0, volume=0.25),), INSTRUMENT, buy=0, sell=1),
            ctrader_position([SimpleNamespace(SymbolName=INSTRUMENT, TradeType="Buy", VolumeInUnits=42.0)],
                             INSTRUMENT, buy="Buy", sell="Sell"),
        )
        self.assertEqual(snapshots, ("long", "long", "long"))
        self.assertEqual(alpaca_position([], INSTRUMENT), "flat")
        self.assertEqual(mt5_position((), INSTRUMENT, buy=0, sell=1), "flat")
        self.assertEqual(ctrader_position([], INSTRUMENT, buy="Buy", sell="Sell"), "flat")

    def test_failed_or_ambiguous_snapshots_fail_closed(self):
        long = SimpleNamespace(symbol=INSTRUMENT, type=0, volume=0.25)
        short = SimpleNamespace(symbol=INSTRUMENT, type=1, volume=0.25)
        for rows in (None, (long, short), (SimpleNamespace(symbol="other", type=0, volume=1.0),),
                     (SimpleNamespace(symbol=INSTRUMENT, type=0),)):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                mt5_position(rows, INSTRUMENT, buy=0, sell=1)

    def test_invalid_quantities_and_directions_fail_closed(self):
        for qty in ("NaN", "Infinity", "0", "-1", True, None):
            with self.subTest(qty=qty), self.assertRaises(ValueError):
                alpaca_position([SimpleNamespace(symbol=INSTRUMENT, side="long", qty=qty)], INSTRUMENT)
        with self.assertRaises(ValueError):
            ctrader_position([SimpleNamespace(SymbolName=INSTRUMENT, TradeType="Unknown", VolumeInUnits=1.0)],
                             INSTRUMENT, buy="Buy", sell="Sell")

    def test_transition_preserves_id_and_uses_only_explicit_mapping(self):
        entry = prepare_broker_transition(INSTRUMENT, SPOT_MAP, previous="flat", current="long", **SIGNAL)
        self.assertEqual(json.loads(entry), {
            "id": SIGNAL["signal_id"], "sequence": 1, "symbol": "PILOT", "side": "long",
            "targetBps": 2, "expiresAtMs": SIGNAL["expires_at_ms"],
        })
        self.assertEqual(entry, prepare_broker_transition(INSTRUMENT, SPOT_MAP, previous="flat", current="long", **SIGNAL))
        with self.assertRaises(ValueError):
            prepare_broker_transition(INSTRUMENT, {}, previous="flat", current="long", **SIGNAL)

    def test_flat_is_explicit_and_repeated_states_emit_nothing(self):
        closing = {**SIGNAL, "signal_id": "position-event-02", "sequence": 2}
        exit_signal = prepare_broker_transition(INSTRUMENT, SPOT_MAP, previous="long", current="flat", **closing)
        self.assertEqual((json.loads(exit_signal)["side"], json.loads(exit_signal)["targetBps"]), ("flat", 0))
        for state in ("long", "flat"):
            self.assertIsNone(prepare_broker_transition(INSTRUMENT, SPOT_MAP, previous=state, current=state, **SIGNAL))
        with self.assertRaises(ValueError):
            prepare_broker_transition(INSTRUMENT, SPOT_MAP, previous="unknown", current="flat", **SIGNAL)


if __name__ == "__main__":
    unittest.main()
