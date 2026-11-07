"""Send one prepared signal to the local AudaceFi signal receiver."""

from contextlib import closing
import http.client
import json
import re
from typing import Mapping, NamedTuple


class SignalReply(NamedTuple):
    status: str
    retry_after_seconds: int | None = None
    receipt: dict | None = None


def prepare_signal(instrument: str, symbol_map: Mapping[str, str], *, signal_id: str,
                   sequence: int, side: str, target_bps: int, expires_at_ms: int) -> bytes:
    """Build bytes from an operator-approved symbol mapping and producer-assigned identity."""
    symbol = symbol_map.get(instrument)
    if not isinstance(symbol, str) or not re.fullmatch(r"[A-Z0-9_-]{1,16}", symbol) or symbol == "USDC":
        raise ValueError("The instrument has no approved spot symbol.")
    if any(other != instrument and target == symbol for other, target in symbol_map.items()):
        raise ValueError("Use one source instrument per AudaceFi spot symbol and journal.")
    if not isinstance(signal_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", signal_id):
        raise ValueError("The signal ID must contain 8 to 64 URL-safe characters.")
    if type(sequence) is not int or not 1 <= sequence <= 10**12:
        raise ValueError("The sequence is outside the allowed range.")
    if (side not in ("long", "flat") or type(target_bps) is not int
            or (side == "long" and not 1 <= target_bps <= 10_000)
            or (side == "flat" and target_bps != 0)):
        raise ValueError("Choose a positive long allocation or a zero-allocation flat signal.")
    if type(expires_at_ms) is not int or not 1 <= expires_at_ms <= 8_000_000_000_000:
        raise ValueError("Provide the absolute expiry as an integer Unix time in milliseconds.")
    return json.dumps({
        "id": signal_id, "sequence": sequence, "symbol": symbol, "side": side,
        "targetBps": target_bps, "expiresAtMs": expires_at_ms,
    }, separators=(",", ":")).encode("ascii")


def prepare_strategy_transition(instrument: str, symbol_map: Mapping[str, str], *, previous: str,
                                current: str, signal_id: str, sequence: int, target_bps: int,
                                expires_at_ms: int, short_to_flat: bool = False) -> bytes | None:
    """Translate an explicit strategy decision using the last confirmed AudaceFi position."""
    if type(instrument) is not str or not instrument.strip():
        raise ValueError("Provide the exact source instrument ID.")
    if previous not in ("long", "flat"):
        raise ValueError("Provide a confirmed previous AudaceFi spot state.")
    if type(short_to_flat) is not bool:
        raise ValueError("The short-to-flat policy must be an explicit boolean.")
    if current == "short":
        if not short_to_flat or previous != "long":
            raise ValueError("A short requires explicit approval to close a confirmed spot long.")
        current = "flat"
    payload = prepare_signal(instrument, symbol_map, signal_id=signal_id, sequence=sequence,
                             side=current, target_bps=target_bps if current == "long" else 0,
                             expires_at_ms=expires_at_ms)
    return None if current == previous else payload


def _has_ranked_receipt(result: dict) -> bool:
    position = result.get("positionAfterRaw")
    if (type(result.get("simulatedFeeBps")) is not int or result["simulatedFeeBps"] != 20
            or not isinstance(position, str) or not re.fullmatch(r"0|[1-9][0-9]{0,19}", position)
            or int(position) > 2**64 - 1):
        return False
    for name, pattern in (
        ("operationKey", r"[a-f0-9]{64}"),
        ("intentId", r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}"),
        ("txid", r"[1-9A-HJ-NP-Za-km-z]{64,88}"),
    ):
        value = result.get(name)
        if not isinstance(value, str) or not re.fullmatch(pattern, value):
            return False
    return True


def _receiver(port: int, token: str):
    if type(port) is not int or not 1024 <= port <= 65535:
        raise ValueError("Provide a receiver port between 1024 and 65535.")
    if (not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token)
            or token.lower().startswith("afk_")):
        raise ValueError("Provide a valid local receiver token.")
    return http.client.HTTPConnection("127.0.0.1", port, timeout=65)


def _response_object(response):
    if response.getheader("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
        return None
    length = response.getheader("Content-Length", "")
    if not re.fullmatch(r"[1-9][0-9]{0,3}", length):
        return None
    size = int(length)
    if size > 4096 or response.getheader("Transfer-Encoding") is not None:
        return None
    raw = response.read(size)
    if len(raw) != size:
        return None
    result = json.loads(raw.decode("utf-8"))
    return result if isinstance(result, dict) else None


def read_run_scope(*, port: int, token: str) -> str:
    """Read the current scope before preparing and persisting a new run."""
    try:
        with closing(_receiver(port, token)) as connection:
            connection.request("GET", "/scope", headers={"Authorization": "Bearer " + token})
            response = connection.getresponse()
            result = _response_object(response)
            if response.status == 200 and result is not None and result.keys() == {"runScope"}:
                scope = result["runScope"]
                if isinstance(scope, str) and re.fullmatch(r"[0-9a-f]{64}", scope):
                    return scope
    except (OSError, http.client.HTTPException, UnicodeError, json.JSONDecodeError, RecursionError):
        pass
    raise RuntimeError("The receiver run scope could not be verified.")


def send_signal(payload: bytes, *, port: int, token: str, run_scope: str) -> SignalReply:
    """Make one POST using the original saved scope and bytes."""
    if not isinstance(run_scope, str) or not re.fullmatch(r"[0-9a-f]{64}", run_scope):
        raise ValueError("Provide the run scope saved with this signal.")
    if not isinstance(payload, bytes) or not 1 <= len(payload) <= 512 or b"\r" in payload or b"\n" in payload:
        raise ValueError("Provide one saved signal as 1 to 512 bytes without a line ending.")
    try:
        signal = json.loads(payload)
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise ValueError("Provide a saved JSON signal.") from None
    if (not isinstance(signal, dict) or not isinstance(signal.get("id"), str)
            or type(signal.get("sequence")) is not int or signal.get("side") not in ("long", "flat")):
        raise ValueError("The saved signal identity is invalid.")
    try:
        with closing(_receiver(port, token)) as connection:
            connection.request("POST", "/signal", body=payload, headers={
                "Authorization": "Bearer " + token,
                "Content-Type": "application/json",
                "Content-Length": str(len(payload)),
                "X-AudaceFi-Run-Scope": run_scope,
            })
            response = connection.getresponse()
            result = _response_object(response)
            if result is None:
                return SignalReply("unknown")
            status = result.get("status")
            if response.status == 200:
                if (result.get("signalId") != signal["id"] or type(result.get("sequence")) is not int
                        or result["sequence"] != signal["sequence"]):
                    return SignalReply("unknown")
                if (status == "ranked" and result.get("ranked") is True and _has_ranked_receipt(result)
                        and (result["positionAfterRaw"] == "0") == (signal["side"] == "flat")):
                    return SignalReply("ranked", receipt=result)
                if status in ("finality-pending", "ranking-pending", "review-required") and result.get("ranked") is False:
                    operation_key = result.get("operationKey")
                    receipt = result if isinstance(operation_key, str) and re.fullmatch(r"[a-f0-9]{64}", operation_key) else None
                    return SignalReply(status, receipt=receipt)
                if status == "closed-unranked" and result.get("ranked") is False:
                    return SignalReply(status, receipt=result)
            if response.status == 429 and result == {"status": "rejected", "code": "SIGNAL_IN_PROGRESS"}:
                retry_after = response.getheader("Retry-After", "")
                if re.fullmatch(r"[1-9][0-9]?", retry_after) and int(retry_after) <= 60:
                    return SignalReply("busy", retry_after_seconds=int(retry_after))
            if response.status == 409 and result == {"status": "rejected", "code": "SIGNAL_RUN_SCOPE_MISMATCH"}:
                return SignalReply("scope-mismatch")
            if response.status in (400, 401, 403, 404, 405, 408, 411, 413, 415) and status == "rejected":
                return SignalReply("rejected")
    except (OSError, http.client.HTTPException, UnicodeError, json.JSONDecodeError, RecursionError):
        return SignalReply("unknown")
    return SignalReply("unknown")
