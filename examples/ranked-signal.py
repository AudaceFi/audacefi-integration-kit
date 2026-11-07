"""Run a supervised Python long-to-flat sequence against a reviewed operator."""

import argparse
import json
import os
from pathlib import Path
from queue import Empty, Queue
import re
import stat
import subprocess
import sys
import threading
import time
import uuid


def sync_directory(directory):
    if os.name == "posix":
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def bind_run_scope(directory, scope):
    if not isinstance(scope, str) or not re.fullmatch(r"[0-9a-f]{64}", scope):
        raise ValueError("The gateway returned an invalid run scope.")
    marker = directory / "run-scope"
    expected = (scope + "\n").encode("ascii")
    try:
        info = marker.lstat()
    except FileNotFoundError:
        if any(os.path.lexists(directory / f"{side}.json") for side in ("long", "flat")):
            raise ValueError("Saved signals have no verified run scope.") from None
        descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as new:
            new.write(expected)
            new.flush()
            os.fsync(new.fileno())
    else:
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (
            os.name == "posix" and (info.st_mode & 0o077 or info.st_uid != os.geteuid())
        ):
            raise ValueError("The run scope marker is unsafe.")
        with marker.open("r+b") as existing:
            if existing.read(len(expected) + 1) != expected:
                raise ValueError("Saved signals belong to another gateway scope.")
            os.fsync(existing.fileno())
    sync_directory(directory)


def saved_signal(directory, side, sequence, symbol, target_bps):
    path = directory / f"{side}.json"
    try:
        info = path.lstat()
    except FileNotFoundError:
        signal = {
            "id": str(uuid.uuid4()),
            "sequence": sequence,
            "symbol": symbol,
            "side": side,
            "targetBps": target_bps,
            "expiresAtMs": time.time_ns() // 1_000_000 + 55_000,
        }
        line = json.dumps(signal, separators=(",", ":")).encode("ascii") + b"\n"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as new:
            new.write(line)
            new.flush()
            os.fsync(new.fileno())
        sync_directory(directory)
    else:
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (
            os.name == "posix" and (info.st_mode & 0o077 or info.st_uid != os.geteuid())
        ):
            raise ValueError("The saved signal file is unsafe.")
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
        with os.fdopen(descriptor, "rb") as existing:
            if not os.path.samestat(info, os.fstat(existing.fileno())):
                raise ValueError("The saved signal file changed while opening it.")
            line = existing.readline(514)
            if len(line) > 513 or not line.endswith(b"\n") or existing.read(1):
                raise ValueError("Invalid saved signal.")
    signal = json.loads(line)
    if any(signal.get(key) != value for key, value in {
        "side": side, "sequence": sequence, "symbol": symbol, "targetBps": target_bps,
    }.items()):
        raise ValueError("Saved signal differs from the selected run.")
    return line


def read_responses(stream, responses):
    while line := stream.readline(4097):
        responses.put(line)
        if len(line) > 4096:
            break
    responses.put(b"")


def read_response(responses, timeout):
    try:
        line = responses.get(timeout=timeout)
    except Empty as error:
        raise TimeoutError("Timed out waiting for the gateway.") from error
    if not line or len(line) > 4096:
        raise RuntimeError("The gateway returned an invalid response.")
    result = json.loads(line)
    if not isinstance(result, dict):
        raise RuntimeError("The gateway returned an invalid response.")
    return result


def wait_for_rank(child, responses, signal, run_scope, timeout):
    sent = json.loads(signal)
    frame = json.dumps({"runScope": run_scope, "signal": signal.removesuffix(b"\n").decode("utf-8")},
                       separators=(",", ":")).encode("utf-8") + b"\n"
    deadline = time.monotonic() + timeout
    delay = 3
    while time.monotonic() < deadline:
        child.stdin.write(frame)
        child.stdin.flush()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        result = read_response(responses, remaining)
        if (result.get("signalId") != sent["id"] or type(result.get("sequence")) is not int
                or result["sequence"] != sent["sequence"]):
            raise RuntimeError("The gateway response does not identify the saved signal.")
        if result.get("status") == "ranked" and result.get("ranked") is True:
            if result.get("simulatedFeeBps") != 20:
                raise RuntimeError("The ranked receipt did not verify the fee.")
            return result
        if result.get("status") not in {"finality-pending", "ranking-pending"}:
            key = result.get("operationKey")
            if isinstance(key, str) and re.fullmatch(r"[a-f0-9]{64}", key):
                print(f"Review operation {key} in the original journal.", file=sys.stderr)
            raise RuntimeError("The gateway requires operator review.")
        time.sleep(min(delay, max(0, deadline - time.monotonic())))
        delay = min(delay * 2, 30)
    raise TimeoutError("Ranking proof is still pending. Keep the saved signals for reconciliation.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--operator", required=True, type=Path)
    parser.add_argument("--target", choices=("validation", "official"), default="validation")
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--target-bps", required=True, type=int)
    parser.add_argument("--first-sequence", default=1, type=int)
    parser.add_argument("--timeout", default=600, type=int)
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    if (not args.operator.is_absolute() or not re.fullmatch(r"[A-Z0-9_-]{1,16}", args.symbol)
            or not 1 <= args.target_bps <= 10_000 or not 1 <= args.first_sequence < 10**12
            or not 1 <= args.timeout <= 1800):
        parser.error("Provide an absolute operator path and valid symbol, position size, sequence and timeout.")
    args.run_dir.mkdir(mode=0o700, exist_ok=True)
    if args.run_dir.is_symlink() or (os.name == "posix" and args.run_dir.stat().st_mode & 0o077):
        parser.error("Use a run directory with access limited to the operator.")

    cli = Path(__file__).resolve().parents[1] / "dist" / "ranked-signal-cli.js"
    command = [args.node, str(cli), "--execute", "--operator", str(args.operator), "--emit-ready-scope"]
    if args.target == "official":
        command += ["--target", "official"]
    with subprocess.Popen(
        command,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    ) as child:
        responses = Queue(maxsize=2)
        threading.Thread(target=read_responses, args=(child.stdout, responses), daemon=True).start()
        try:
            ready = read_response(responses, args.timeout)
            if ready.get("status") != "ready" or ready.keys() != {"status", "runScope"}:
                raise RuntimeError("The gateway did not provide its run scope.")
            bind_run_scope(args.run_dir, ready["runScope"])
            for sequence, side, size in (
                (args.first_sequence, "long", args.target_bps),
                (args.first_sequence + 1, "flat", 0),
            ):
                signal = saved_signal(args.run_dir, side, sequence, args.symbol, size)
                result = wait_for_rank(child, responses, signal, ready["runScope"], args.timeout)
                position = result.get("positionAfterRaw")
                if not isinstance(position, str) or not re.fullmatch(r"0|[1-9][0-9]{0,19}", position) or (
                    (position == "0") != (side == "flat")
                ):
                    raise RuntimeError("The ranked receipt did not verify the expected position.")
                print(json.dumps({"side": side, **result}, separators=(",", ":")), flush=True)
        finally:
            child.stdin.close()
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
    return child.returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError):
        raise SystemExit("The ranked signal run stopped. Keep its local state and inspect the operator journal.") from None
