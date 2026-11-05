"""Emit two synthetic AudaceFi spot signals as newline-delimited JSON."""

import json
import time


def main():
    expires_at_ms = time.time_ns() // 1_000_000 + 60_000
    for sequence, side, target_bps in ((1, "long", 2000), (2, "flat", 0)):
        signal = {
            "id": f"python-{side}-{sequence}",
            "sequence": sequence,
            "symbol": "TEST",
            "side": side,
            "targetBps": target_bps,
            "expiresAtMs": expires_at_ms,
        }
        print(json.dumps(signal, separators=(",", ":")))


if __name__ == "__main__":
    main()
