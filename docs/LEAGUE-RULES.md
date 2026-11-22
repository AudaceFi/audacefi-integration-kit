# League rules for Degen and Crypto Bro operators

Your bot's objective is to improve its percentage portfolio performance over the season while meeting the league's trading and eligibility rules. The sandbox runs on Solana devnet with test tokens. Portfolio values are measured in USDC and trading costs affect the result. AudaceFi accounts for external capital movements when calculating performance. If two participants have identical performance, the smaller maximum drawdown ranks first. [Official AudaceFi Rulebook](https://audacefi.com/rulebook)

Read the rulebook's **Devnet Sandbox** section first and follow the actual rules and dates published for your season. The league is spot-only. Your strategy can use signals from another venue, then translate those signals to its approved AudaceFi spot pair and use the supported AudaceFi execution path.

| Category | Typical assets | What the bot must check |
| --- | --- | --- |
| Degen | Memecoins and micro-caps | The asset is explicitly eligible on Degen's frozen list for the active season. |
| Crypto Bro | Established tokens | The asset is explicitly eligible on Crypto Bro's frozen list for the active season. |

Enroll before the season opens. Use the league wallet registered for that category and season, and use a separate wallet if you enter both categories. Select a pair by its exact token mints and follow the season's position constraints and the limits in your approved operator setup.

## Give your bot these decision rules

1. **Before a signal**, confirm that the expected season is active, the category and league wallet match the enrolled setup, and the configured USDC pair is permitted by the frozen allowlist. Hold the signal if the check fails or the API cannot establish current eligibility.
2. **During the season**, keep signals within the configured pair and sizing policy. The adapter's `long` enters the approved spot position and `flat` closes the tracked position into USDC. Plan exits with time to spare before the closing snapshot and reconcile fills before sending another signal. [Operator guide](OPERATOR-SIGNALS.md)
3. **At the opening and closing snapshots**, the general rule is to hold USDC plus only the permitted SOL gas buffer. Check the whole wallet and the rules for your actual season. A `flat` receipt establishes the outcome for the tracked pair.

## Check the league before sending a Python signal

Run the [read-only preflight example](../examples/league_preflight.py) from the kit checkout. Set these shell variables to your enrolled season, registered wallet and selected asset. Choose `degen` or `crypto-bro` to match the enrollment.

```bash
python3 examples/league_preflight.py --live \
  --category degen \
  --season-id "$SEASON_ID" \
  --wallet "$LEAGUE_WALLET" \
  --asset-mint "$ASSET_MINT" \
  --symbol "$ASSET_SYMBOL"
```

Enter your AudaceFi API key with `read` scope at the prompt. The script reads season and wallet context from `/v1/me/state` and token eligibility from `/v1/me/allowlist`. It checks the selected asset and the USDC leg using their mint identities. A successful check exits with code 0. A HOLD exits with code 1. [API contract](CONTRACT.md)

A Python strategy can use the same check in-process. Import from the `examples` directory, provide the key through your operator's credential loader, and run the check before preparing or sending a signal.

```python
from league_preflight import check_league, sandbox_reader

check_league(
    category=category,
    season_id=season_id,
    wallet=league_wallet,
    asset_mint=asset_mint,
    symbol=asset_symbol,
    read_json=sandbox_reader(api_key),
)
```

Handle `PreflightError` by holding the signal. Tests can inject a `read_json` callback backed by synthetic responses. The preflight confirms the context at read time. For ranked execution, use the reviewed deployment profile, signed approval, and gateway checks for the current operation, including the opening snapshot and transaction verification. [Operator guide](OPERATOR-SIGNALS.md)
