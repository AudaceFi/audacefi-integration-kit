import http.client
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples"))
from signal_http_client import SignalReply, prepare_signal, prepare_strategy_transition, read_run_scope, send_signal


TOKEN = "a" * 32
SCOPE = "1" * 64
FIELDS = {
    "signal_id": "event-0001", "sequence": 1, "side": "long",
    "target_bps": 2, "expires_at_ms": 1_800_000_000_000,
}
RANKED_RECEIPT = {
    "status": "ranked", "ranked": True, "simulatedFeeBps": 20, "positionAfterRaw": "100",
    "signalId": "event-0001", "sequence": 1,
    "operationKey": "a" * 64, "intentId": "-".join(("00000001", "0000", "4000", "8000", "000000000000")),
    "txid": "3" * 88,
}


def prepare(instrument="spot-strategy", **overrides):
    return prepare_signal(instrument, {"spot-strategy": "PILOT"}, **{**FIELDS, **overrides})


def stub_response(http_status, body, **overrides):
    raw = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json", "Content-Length": str(len(raw)), **overrides}
    response = Mock(status=http_status)
    response.getheader.side_effect = headers.get
    response.read.side_effect = lambda size: raw[:size]
    return response


class StrategyTransitionTest(unittest.TestCase):
    def transition(self, instrument, symbol_map, **overrides):
        fields = {name: value for name, value in FIELDS.items() if name != "side"}
        return prepare_strategy_transition(instrument, symbol_map,
                                           **{**fields, "previous": "flat", "current": "long", **overrides})

    def test_explicit_futures_options_and_prediction_ids_use_existing_wire_bytes(self):
        for instrument in (
            "cme:NQ:202612",
            "cboe:SPY:20270115:00500000:P",
            "prediction:market-17:outcome-no",
        ):
            with self.subTest(instrument=instrument):
                policy = {instrument: "PILOT"}
                self.assertEqual(self.transition(instrument, policy), prepare())
                self.assertEqual(self.transition(instrument, policy, previous="long", current="flat",
                                                 signal_id="event-0002", sequence=2),
                                 prepare(side="flat", target_bps=0, signal_id="event-0002", sequence=2))

    def test_unsupported_decisions_and_unmapped_instruments_are_refused(self):
        instrument = "prediction:market-17:outcome-no"
        policy = {instrument: "PILOT"}
        for supplied, state in (("prediction:market-17:outcome-yes", "flat"),
                                (instrument.upper(), "long"), ("", "long"),
                                (instrument, "hedged"), (instrument, "unknown")):
            with self.subTest(instrument=supplied, state=state), self.assertRaises(ValueError):
                self.transition(supplied, policy, current=state)
        with self.assertRaises(ValueError):
            self.transition(instrument, policy, previous="pending", current="flat")

    def test_repeated_confirmed_states_emit_no_signal(self):
        instrument = "cme:NQ:202612"
        for state in ("flat", "long"):
            with self.subTest(state=state):
                self.assertIsNone(self.transition(instrument, {instrument: "PILOT"}, previous=state, current=state))

    def test_two_sources_cannot_share_a_spot_position(self):
        with self.assertRaises(ValueError):
            self.transition("cme:ES:202612", {"cme:ES:202612": "PILOT", "cme:NQ:202612": "PILOT"},
                            previous="long", current="flat")

    def test_short_to_flat_requires_explicit_opt_in_and_a_confirmed_long(self):
        instrument = "cme:NQ:202612"
        policy = {instrument: "PILOT"}
        for previous, opt_in in (("long", False), ("flat", True), ("long", "true")):
            with self.subTest(previous=previous, opt_in=opt_in), self.assertRaises(ValueError):
                self.transition(instrument, policy, previous=previous, current="short", short_to_flat=opt_in)
        self.assertEqual(self.transition(instrument, policy, previous="long", current="short", short_to_flat=True),
                         prepare(side="flat", target_bps=0))


class SignalHttpClientTest(unittest.TestCase):
    def setUp(self):
        self.connection_type = self.enterContext(patch("signal_http_client.http.client.HTTPConnection"))
        self.connection = self.connection_type.return_value
        self.payload = prepare()

    def send(self, response):
        self.connection.getresponse.return_value = response
        return send_signal(self.payload, port=8787, token=TOKEN, run_scope=SCOPE)

    def test_long_and_flat_use_explicit_mapping_and_stable_identity(self):
        self.assertEqual(prepare(), self.payload)
        self.assertEqual(json.loads(self.payload), {
            "id": "event-0001", "sequence": 1, "symbol": "PILOT", "side": "long",
            "targetBps": 2, "expiresAtMs": 1_800_000_000_000,
        })
        flat = json.loads(prepare(side="flat", target_bps=0, signal_id="event-0002", sequence=2))
        self.assertEqual((flat["side"], flat["targetBps"], flat["sequence"]), ("flat", 0, 2))

    def test_unmapped_instruments_shorts_and_invalid_sequences_never_send(self):
        for parameters in ({"instrument": "NQ"}, {"side": "short"}, {"sequence": True}, {"side": "flat"}):
            with self.subTest(parameters=parameters), self.assertRaises(ValueError):
                prepare(**parameters)
        self.connection_type.assert_not_called()

    def test_sends_exact_body_once_to_fixed_loopback_endpoint(self):
        receipt = RANKED_RECEIPT
        self.assertEqual(self.send(stub_response(200, receipt)), SignalReply("ranked", receipt=receipt))
        self.connection_type.assert_called_once_with("127.0.0.1", 8787, timeout=65)
        self.connection.request.assert_called_once_with("POST", "/signal", body=self.payload, headers={
            "Authorization": "Bearer " + TOKEN,
            "Content-Type": "application/json",
            "Content-Length": str(len(self.payload)),
            "X-AudaceFi-Run-Scope": SCOPE,
        })
        self.connection.close.assert_called_once_with()

    def test_reports_pending_and_busy_without_retrying(self):
        self.assertEqual(self.send(stub_response(200, {"status": "ranking-pending", "ranked": False,
                                                       "signalId": "event-0001", "sequence": 1})),
                         SignalReply("ranking-pending"))
        self.assertEqual(self.send(stub_response(429, {"status": "rejected", "code": "SIGNAL_IN_PROGRESS"},
                                                  **{"Retry-After": "1"})), SignalReply("busy", 1))
        self.assertEqual(self.connection.request.call_count, 2)

    def test_preserves_the_operation_key_on_a_matching_review_receipt(self):
        receipt = {"status": "review-required", "ranked": False, "signalId": "event-0001",
                   "sequence": 1, "operationKey": "7" * 64}
        self.assertEqual(self.send(stub_response(200, receipt)), SignalReply("review-required", receipt=receipt))
        self.assertEqual(self.connection.request.call_count, 1)

    def test_scope_discovery_and_mismatch_never_resubmit(self):
        self.connection.getresponse.return_value = stub_response(200, {"runScope": SCOPE})
        self.assertEqual(read_run_scope(port=8787, token=TOKEN), SCOPE)
        self.connection.request.assert_called_once_with("GET", "/scope", headers={"Authorization": "Bearer " + TOKEN})
        self.assertEqual(self.send(stub_response(409, {"status": "rejected", "code": "SIGNAL_RUN_SCOPE_MISMATCH"})),
                         SignalReply("scope-mismatch"))
        self.assertEqual(self.connection.request.call_count, 2)

    def test_timeout_has_unknown_outcome_and_does_not_retry(self):
        self.connection.getresponse.side_effect = http.client.RemoteDisconnected("synthetic private detail")
        self.assertEqual(send_signal(self.payload, port=8787, token=TOKEN, run_scope=SCOPE), SignalReply("unknown"))
        self.connection.request.assert_called_once()

    def test_ranked_requires_expected_fee_position_and_trade_identifiers(self):
        for receipt in (
            {"status": "ranked", "ranked": True},
            {**RANKED_RECEIPT, "simulatedFeeBps": 10},
            {**RANKED_RECEIPT, "positionAfterRaw": "00"},
            {**RANKED_RECEIPT, "positionAfterRaw": "0"},
            {**RANKED_RECEIPT, "signalId": "event-0002"},
            {**RANKED_RECEIPT, "sequence": 2},
            {**RANKED_RECEIPT, "positionAfterRaw": "18446744073709551616"},
            {**RANKED_RECEIPT, "txid": ""},
        ):
            with self.subTest(receipt=receipt):
                self.assertEqual(self.send(stub_response(200, receipt)), SignalReply("unknown"))

    def test_untrusted_responses_never_return_details_or_trigger_a_redirect(self):
        response_cases = (
            stub_response(504, {"status": "unknown", "detail": "synthetic private detail"}),
            stub_response(307, {"status": "ranked", "ranked": True}, Location="https://elsewhere.invalid"),
            stub_response(200, {"status": "ranked", "ranked": True}, **{"Content-Length": "2048"}),
            stub_response(200, {"status": "ranked", "ranked": True}, **{"Content-Length": "4097"}),
            stub_response(200, {"status": "ranked", "ranked": False}),
            stub_response(200, b"not json"),
        )
        for response in response_cases:
            with self.subTest(response=response.status):
                self.assertEqual(self.send(response), SignalReply("unknown"))
        self.assertEqual(self.connection.request.call_count, len(response_cases))

    def test_invalid_credentials_or_payload_never_open_a_connection(self):
        for arguments in ({"token": "a\n"}, {"port": 0}, {"payload": self.payload + b"\n"}):
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                send_signal(**{**{"payload": self.payload, "port": 8787, "token": TOKEN, "run_scope": SCOPE}, **arguments})
        self.connection_type.assert_not_called()


if __name__ == "__main__":
    unittest.main()
