# Send signals from a Python bot

[`signal_http_client.py`](../examples/signal_http_client.py) is an importable Python 3.11+ example that uses the standard library. Run the bot and the [local HTTP receiver](OPERATOR-SIGNALS.md#start-the-gateway) on the same trusted host. The same client can send to the [isolated validation receiver](ADAPTER.md#local-http-receiver). Only the receiver needs the AudaceFi account and wallet setup. The bot needs the separate local receiver token and its own saved signal state. Supply the token from your bot's approved secret provider and keep it out of arguments, signal payloads and logs.

## Prepare and send one signal

Copy `signal_http_client.py` beside your bot. Read the authenticated receiver scope when starting a new run. Save it with every signal and reuse it during recovery. The gateway checks the scope before accepting a signal and independently checks the configured pair and season allowlist.

```python
from signal_http_client import prepare_strategy_transition, read_run_scope, send_signal


def forward_new_signal(event, approved_symbols, previous, receiver_token, run_scope, store):
    body = prepare_strategy_transition(
        event.instrument, approved_symbols, previous=previous, current=event.decision,
        signal_id=event.durable_id, sequence=event.sequence,
        target_bps=event.target_bps,
        expires_at_ms=event.expires_at_ms,
    )
    if body is None:
        return None
    store.save_before_send(event.durable_id, body, run_scope)
    return send_signal(body, port=8787, token=receiver_token, run_scope=run_scope)
```

In this example `event` and `store` are your bot's objects. Use `read_run_scope(port=8787, token=receiver_token)` once at the start of a new run. Recover a pending signal with the scope saved with its original bytes. Assign each event a stable ID and a strictly increasing sequence per receiver journal. Set a new signal's expiry no more than 60 seconds after creation. A `long` uses a positive target in basis points. A `flat` has zero allocation and targets the recorded spot position. Submit a flat only after the gateway verifies the long. Map one exact source instrument per spot symbol and journal.

For position-driven strategies, see the [Alpaca, MetaTrader 5 and cTrader examples](BROKER-POSITIONS.md).

## Handle one reply before advancing

`send_signal` makes one request to `127.0.0.1` and does not follow redirects. Each reply has a `status`. Successful gateway replies include the signal ID and sequence. A `ranked` reply includes the operation key, intent ID, transaction signature, 20 bps fee rate and raw position. Store it with the corresponding saved signal. The client requires a positive raw position for a long and exactly `"0"` for a flat.

| Status | Producer action |
| --- | --- |
| `finality-pending` or `ranking-pending` | Back off and use the same saved bytes to reconcile the existing signal. |
| `busy` | Wait at least `retry_after_seconds` and keep the same saved signal. |
| `scope-mismatch` | Pause and restore the original receiver scope and journal. Keep the saved signal and scope together. |
| `closed-unranked` | The gateway closed its local recovery row. Inspect the reason and raw position before resuming. This receipt makes no claim about inclusion in the leaderboard. |
| `review-required`, `rejected` or `unknown` | Pause. Preserve the bytes and check the receiver and operator journal before retrying or advancing to another signal. A timed-out request may still be working. |

## Run the offline client tests

```sh
python3 -B -m unittest discover -s test -p test_signal_http_client.py
```

The tests replace the HTTP transport with a fixture.
