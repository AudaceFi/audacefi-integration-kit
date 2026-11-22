"""Check a configured league scope before an operator considers a trade."""

import argparse
from datetime import datetime, timezone
from getpass import getpass, GetPassWarning
from http.client import HTTPSConnection, HTTPException
import json
import re
import sys
import warnings


CATEGORIES = ("degen", "crypto-bro")
SANDBOX_HOST = "sandbox.audacefi.app"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
MAX_RESPONSE_BYTES = 262_144
PUBLIC_KEY = re.compile(r"[1-9A-HJ-NP-Za-km-z]{32,44}")
SEASON_ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.I)
SYMBOL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,15}")
UTC_TIMESTAMP = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z")


class PreflightError(RuntimeError):
    """Hold the signal because the league context could not be verified."""


def _paths(category):
    return (
        f"/api/v1/me/state?category={category}&mode=real",
        f"/api/v1/me/allowlist?category={category.replace('-', '_')}&mode=real",
    )


def sandbox_reader(api_key):
    """Build an explicit GET-only reader for the official HTTPS sandbox."""
    if not isinstance(api_key, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{8,512}", api_key):
        raise PreflightError("The API key format is invalid.")
    allowed_paths = {path for category in CATEGORIES for path in _paths(category)}

    def read_json(path):
        if path not in allowed_paths:
            raise PreflightError("This API path is outside the preflight scope.")
        connection = HTTPSConnection(SANDBOX_HOST, timeout=5)
        try:
            connection.request("GET", path, headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
                "Cache-Control": "no-cache",
            })
            response = connection.getresponse()
            if response.status != 200:
                raise PreflightError(f"The API read returned HTTP {response.status}.")
            media_type = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
            if media_type != "application/json":
                raise PreflightError("The API did not return JSON.")
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(body) > MAX_RESPONSE_BYTES:
                raise PreflightError("The API response exceeded the size limit.")
            return json.loads(body)
        except (HTTPException, OSError, ValueError, RecursionError):
            raise PreflightError("The API read failed or returned invalid JSON.") from None
        finally:
            connection.close()

    return read_json


def _object(value):
    if not isinstance(value, dict):
        raise PreflightError("The API response is missing league context.")
    return value


def _timestamp(value):
    if not isinstance(value, str) or not UTC_TIMESTAMP.fullmatch(value):
        raise PreflightError("The league timestamp is missing or invalid.")
    try:
        return datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        raise PreflightError("The league timestamp is invalid.") from None


def _check_window(as_of, starts_at, ends_at, now):
    if not starts_at <= now < ends_at:
        raise PreflightError("The season is outside its execution window.")
    if not -30 <= (now - as_of).total_seconds() <= 120:
        raise PreflightError("The league state is stale or ahead of the local clock.")


def _check_pair(tokens, asset_mint, symbol):
    if not isinstance(tokens, list) or len(tokens) > 2_048:
        raise PreflightError("The token list is invalid.")
    by_mint = {}
    symbol_matches = []
    for value in tokens:
        token = _object(value)
        mint = token.get("mint")
        if not isinstance(mint, str) or not PUBLIC_KEY.fullmatch(mint) or mint in by_mint:
            raise PreflightError("The token list contains an invalid or duplicate mint.")
        by_mint[mint] = token
        label = token.get("symbol")
        if isinstance(label, str) and SYMBOL.fullmatch(label) and label.upper() == symbol:
            symbol_matches.append(token)

    asset = by_mint.get(asset_mint, {})
    decimals = asset.get("decimals")
    if (len(symbol_matches) != 1 or symbol_matches[0] is not asset
            or asset.get("eligible") is not True or asset.get("exempt") is not False
            or type(decimals) is not int or not 0 <= decimals <= 9):
        raise PreflightError("The configured spot asset is not uniquely eligible.")

    usdc = by_mint.get(USDC_MINT, {})
    decimals = usdc.get("decimals")
    if (type(decimals) is not int or decimals != 6
            or type(usdc.get("eligible")) is not bool or type(usdc.get("exempt")) is not bool
            or not (usdc["eligible"] or usdc["exempt"])):
        raise PreflightError("Canonical USDC is unavailable for this pair.")


def check_league(*, category, season_id, wallet, asset_mint, symbol, read_json, now=None):
    """Return after a fresh scope and pair check, or raise PreflightError."""
    if (
        category not in CATEGORIES
        or not isinstance(season_id, str) or not SEASON_ID.fullmatch(season_id)
        or not isinstance(wallet, str) or not PUBLIC_KEY.fullmatch(wallet)
        or not isinstance(asset_mint, str) or not PUBLIC_KEY.fullmatch(asset_mint)
        or asset_mint == USDC_MINT
        or not isinstance(symbol, str) or not SYMBOL.fullmatch(symbol)
    ):
        raise PreflightError("Provide a valid category, season ID, league wallet and spot asset.")
    if now is not None and (not isinstance(now, datetime) or now.utcoffset() is None):
        raise PreflightError("The preflight clock must include a time zone.")

    season_id = season_id.lower()
    wire_category = category.replace("-", "_")
    state_path, allowlist_path = _paths(category)
    state = _object(read_json(state_path))
    if state.get("category") != category or state.get("mode") != "real":
        raise PreflightError("The API returned a different league category or mode.")
    season = _object(_object(state.get("season")).get("active"))
    if (season.get("id"), season.get("status"), season.get("executionMode")) != (
        season_id, "active", "devnet_onchain",
    ):
        raise PreflightError("The configured on-chain Devnet season is not active.")
    as_of = _timestamp(state.get("asOf"))
    starts_at = _timestamp(season.get("startsAt"))
    ends_at = _timestamp(season.get("endsAt"))
    _check_window(as_of, starts_at, ends_at, now or datetime.now(timezone.utc))

    enrolled = _object(state.get("wallet"))
    if (
        enrolled.get("state") != "ok"
        or enrolled.get("walletAddress") != wallet
        or enrolled.get("seasonId") != season_id
        or enrolled.get("category") != wire_category
        or enrolled.get("mode") != "real"
        or enrolled.get("seasonExecutionMode") != "devnet_onchain"
    ):
        raise PreflightError("The enrolled league wallet does not match the configured scope.")

    allowlist = _object(read_json(allowlist_path))
    if (
        allowlist.get("seasonId") != season_id
        or allowlist.get("category") != wire_category
        or allowlist.get("allowlistFrozen") is not True
    ):
        raise PreflightError("A frozen allowlist for the configured season and category is unavailable.")
    _check_pair(allowlist.get("tokens"), asset_mint, symbol.upper())
    _check_window(as_of, starts_at, ends_at, now or datetime.now(timezone.utc))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", required=True, help="Read the official API.")
    parser.add_argument("--category", choices=CATEGORIES, required=True)
    parser.add_argument("--season-id", required=True)
    parser.add_argument("--wallet", required=True, help="Enrolled league wallet public address.")
    parser.add_argument("--asset-mint", required=True, help="Approved spot asset's canonical mint.")
    parser.add_argument("--symbol", required=True, help="Approved spot asset's symbol.")
    args = parser.parse_args()
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", GetPassWarning)
            api_key = getpass("AudaceFi API key with read scope: ")
        check_league(
            category=args.category, season_id=args.season_id, wallet=args.wallet,
            asset_mint=args.asset_mint, symbol=args.symbol, read_json=sandbox_reader(api_key),
        )
    except (EOFError, GetPassWarning, KeyboardInterrupt):
        print("HOLD - An interactive key prompt is required.", file=sys.stderr)
        return 1
    except PreflightError as error:
        print(f"HOLD - {error}", file=sys.stderr)
        return 1
    print("League preflight passed. Season, wallet and pair verified.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
