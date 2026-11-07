# Forward broker strategy positions from Python

[`broker_position_signals.py`](../examples/broker_position_signals.py) converts a confirmed position transition from Alpaca, MetaTrader 5 or cTrader into one AudaceFi spot signal. Copy it with [`signal_http_client.py`](../examples/signal_http_client.py). The examples use a [local receiver](PYTHON-HTTP.md) on the same trusted host and standard-library code for signal preparation and delivery.

Choose one exact source instrument and one spot symbol from the operator's approved pair. Give each spot position and journal one source instrument. The mapping belongs to the operator. Use your approved `target_bps` for a long. A flat targets the whole AudaceFi spot position.

## Read the strategy position

Supply a complete, current snapshot for one strategy and instrument. An empty successful snapshot means flat. A failed or incomplete read requires operator review. If the account or symbol is shared with another strategy, first establish ownership of its positions. In particular, a netting account can combine orders into one position.

### Alpaca

With your bot's existing `alpaca-py` trading client, take a successful `get_all_positions()` snapshot. Filter by your exact symbol on a dedicated strategy account. `Position.side` and `Position.qty` identify an open long. [Alpaca positions](https://alpaca.markets/sdks/python/api_reference/trading/positions.html) · [Position model](https://alpaca.markets/sdks/python/api_reference/trading/models.html#alpaca.trading.models.Position)

```python
from broker_position_signals import alpaca_position

positions = client.get_all_positions()
current = alpaca_position([p for p in positions if p.symbol == instrument], instrument)
```

### MetaTrader 5

Use the terminal connection your strategy already manages. On a netting account, dedicate the symbol to the strategy and pass the full symbol snapshot. A magic-number filter can hide a combined position. On a confirmed hedging account, filter individual positions by a magic number exclusive to the strategy. Pass the terminal's direction constants. [MetaTrader 5 positions](https://www.mql5.com/en/docs/python_metatrader5/mt5positionsget_py) · [Netting behavior](https://www.mql5.com/en/docs/trading/positiongetsymbol) · [Position properties](https://www.mql5.com/en/docs/constants/tradingconstants/positionproperties)

```python
from broker_position_signals import mt5_position

positions = mt5.positions_get(symbol=instrument)
if positions is None:
    raise RuntimeError("The MetaTrader 5 position snapshot failed.")
# This account and instrument are exclusive to the strategy.
current = mt5_position(positions, instrument, buy=mt5.POSITION_TYPE_BUY, sell=mt5.POSITION_TYPE_SELL)
```

### cTrader

In a local Python cBot, use the existing Algo `api`. The example uses separately identifiable positions with a strategy-exclusive label. For a netted symbol, require exclusive strategy ownership and take the full symbol snapshot from `api.Positions`. Pass `TradeType` values from the cBot's cTrader API. [cTrader positions collection](https://help.ctrader.com/ctrader-algo/references/Trading/Positions/Positions/) · [Position fields](https://help.ctrader.com/ctrader-algo/references/Trading/Positions/Position/)

```python
from broker_position_signals import ctrader_position

positions = list(api.Positions.FindAll(strategy_label, instrument))
current = ctrader_position(positions, instrument, buy=TradeType.Buy, sell=TradeType.Sell)
```

## Forward an approved transition

Store the last confirmed AudaceFi state with the strategy. Advance it only after the matching ranked receipt verifies the intended position. A repeated long or repeated flat emits no signal. Shorts and mixed long/short snapshots require operator review.

```python
from broker_position_signals import prepare_broker_transition
from signal_http_client import send_signal

body = prepare_broker_transition(
    instrument, approved_symbol_map, previous=last_confirmed_state, current=current,
    signal_id=event_id, sequence=sequence, target_bps=approved_entry_bps,
    expires_at_ms=expires_at_ms,
)
if body is not None:
    store.save_before_send(event_id, body, run_scope)
    reply = send_signal(body, port=8787, token=receiver_token, run_scope=run_scope)
```

The bot owns the event ID, increasing sequence, expiry and saved bytes. Run the synchronous HTTP request in a single operator-owned worker so a delayed receipt leaves broker event callbacks free. Reconcile an existing signal before accepting the next transition. Follow the [reply and recovery rules](PYTHON-HTTP.md#handle-one-reply-before-advancing) when the outcome is uncertain. Validate all three converters without connecting to a broker or wallet.

```sh
python3 -B -m unittest discover -s test -p test_broker_position_signals.py
```

## TradingView alert template for operator review

Use a TradingView notification as a proposal in an operator review queue. The local AudaceFi receiver expects an authenticated kit signal and is reachable only on the operator host. A direct TradingView delivery needs a separate public HTTPS ingress that durably accepts the proposal within three seconds. [TradingView webhook setup](https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/) · [TradingView credential guidance](https://www.tradingview.com/support/solutions/43000722015-using-credentials-for-webhooks/)

Use one alert for each direction. Give each alert a unique operator label and set the `proposal` value to `long` or `flat` when creating it.

```json
{
  "alert": "strategy-long",
  "instrument": "{{exchange}}:{{ticker}}",
  "firedAt": "{{timenow}}",
  "proposal": "long"
}
```

Keep keys and passwords out of the alert message and URL. The TradingView HTTPS client certificate identifies the delivery service. The receiving operator still has to establish which strategy and account authorized the proposal. Deduplicate deliveries before review and leave conflicting proposals pending. TradingView can resend some failed deliveries, and its fire time has one-second resolution. After review, the operator prepares a fresh kit signal with an explicit mapping, durable ID, sequence and approved allocation. [Alert placeholders](https://www.tradingview.com/support/solutions/43000531021-how-to-use-a-variable-value-in-alert/) · [Webhook authentication](https://www.tradingview.com/support/solutions/43000680459-webhook-authentication/) · [Webhook resubmission](https://www.tradingview.com/support/solutions/43000735201-webhook-resubmission/)
