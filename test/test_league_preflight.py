import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples"))
from league_preflight import PreflightError, USDC_MINT, check_league, sandbox_reader


SEASON = str(UUID(int=1, version=4))
OTHER_SEASON = str(UUID(int=2, version=4))
WALLET = "3" * 44
ASSET = "4" * 44
NOW = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)


class LeaguePreflightTest(unittest.TestCase):
    def setUp(self):
        self.configure("degen")

    def configure(self, category):
        self.category = category
        self.wire_category = category.replace("-", "_")
        self.state = {
            "asOf": "2026-01-01T11:59:50.000Z",
            "mode": "real",
            "category": category,
            "season": {"active": {
                "id": SEASON,
                "status": "active",
                "executionMode": "devnet_onchain",
                "startsAt": "2026-01-01T10:00:00.000Z",
                "endsAt": "2026-01-01T14:00:00.000Z",
            }},
            "wallet": {
                "state": "ok",
                "mode": "real",
                "seasonExecutionMode": "devnet_onchain",
                "category": self.wire_category,
                "seasonId": SEASON,
                "walletAddress": WALLET,
            },
        }
        self.allowlist = {
            "seasonId": SEASON,
            "category": self.wire_category,
            "allowlistFrozen": True,
            "tokens": [
                {"mint": ASSET, "symbol": "Pilot", "decimals": 5, "eligible": True, "exempt": False},
                {"mint": USDC_MINT, "symbol": "USDC", "decimals": 6, "eligible": False, "exempt": True},
            ],
        }
        self.reads = []
        self.state_path = f"/api/v1/me/state?category={category}&mode=real"
        self.allowlist_path = f"/api/v1/me/allowlist?category={self.wire_category}&mode=real"

    def read_json(self, path):
        self.reads.append(path)
        return {self.state_path: self.state, self.allowlist_path: self.allowlist}[path]

    def check(self, symbol="PILOT"):
        return check_league(
            category=self.category,
            season_id=SEASON,
            wallet=WALLET,
            asset_mint=ASSET,
            symbol=symbol,
            read_json=self.read_json,
            now=NOW,
        )

    def assert_state_rejected(self):
        with self.assertRaises(PreflightError):
            self.check()
        self.assertEqual(self.reads, [self.state_path])

    def test_reads_matching_state_and_allowlist_for_both_categories(self):
        for category in ("degen", "crypto-bro"):
            with self.subTest(category=category):
                self.configure(category)
                self.assertIsNone(self.check())
                self.assertEqual(self.reads, [self.state_path, self.allowlist_path])

    def test_refuses_to_continue_without_an_active_season(self):
        self.state["season"]["active"] = None
        self.assert_state_rejected()

    def test_refuses_to_continue_at_the_season_close(self):
        self.state["season"]["active"]["endsAt"] = "2026-01-01T12:00:00.000Z"
        self.assert_state_rejected()

    def test_refuses_stale_state(self):
        self.state["asOf"] = "2026-01-01T11:57:59.000Z"
        self.assert_state_rejected()

    def test_refuses_a_different_wallet(self):
        self.state["wallet"]["walletAddress"] = "5" * 44
        self.assert_state_rejected()

    def test_refuses_an_unfrozen_or_wrong_season_allowlist(self):
        for changes in ({"allowlistFrozen": False}, {"seasonId": OTHER_SEASON}, {"category": "crypto_bro"}):
            with self.subTest(changes=changes):
                self.configure("degen")
                self.allowlist.update(changes)
                with self.assertRaises(PreflightError):
                    self.check()

    def test_refuses_a_denied_asset_or_ambiguous_symbol(self):
        self.allowlist["tokens"][0]["eligible"] = False
        with self.assertRaises(PreflightError):
            self.check()

        self.configure("degen")
        self.allowlist["tokens"].append({"mint": "6" * 44, "symbol": "PILOT", "decimals": 5,
                                         "eligible": True, "exempt": False})
        with self.assertRaises(PreflightError):
            self.check()

    def test_preflight_matches_extended_labels_by_alias_and_mint(self):
        for symbol in ("$WIF", "LMAO!", "Old Slerf"):
            with self.subTest(symbol=symbol):
                self.configure("degen")
                self.allowlist["tokens"][0]["symbol"] = symbol
                self.assertIsNone(self.check(symbol=symbol.upper()))
                self.allowlist["tokens"].append({
                    "mint": "6" * 44, "symbol": symbol.lower(), "decimals": 5,
                    "eligible": True, "exempt": False,
                })
                with self.assertRaises(PreflightError):
                    self.check(symbol=symbol)


class SandboxReaderTest(unittest.TestCase):
    def setUp(self):
        self.key = "_".join(("afk", "d" * 12, "e" * 16))
        self.connection_type = self.enterContext(patch("league_preflight.HTTPSConnection"))
        self.connection = self.connection_type.return_value

    def test_does_not_follow_redirects_or_read_their_payloads(self):
        response = self.connection.getresponse.return_value
        response.status = 302
        read_json = sandbox_reader(self.key)
        with self.assertRaises(PreflightError):
            read_json("/api/v1/me/state?category=degen&mode=real")

        self.connection_type.assert_called_once()
        self.assertEqual(self.connection_type.call_args.args[0], "sandbox.audacefi.app")
        self.connection.request.assert_called_once()
        self.assertEqual(self.connection.request.call_args.args[0], "GET")
        response.read.assert_not_called()
        self.connection.close.assert_called_once()

    def test_rejects_an_absolute_url_before_connecting(self):
        read_json = sandbox_reader(self.key)
        with self.assertRaises(PreflightError):
            read_json("https://other.test/api/v1/me/allowlist?category=degen&mode=real")
        self.connection_type.assert_not_called()


if __name__ == "__main__":
    unittest.main()
