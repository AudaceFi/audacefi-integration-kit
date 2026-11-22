# League rules for Degen and Crypto Bro operators

Your bot's objective is to improve its percentage portfolio performance over the season while meeting the league's trading and eligibility rules. The sandbox runs on Solana devnet with test tokens. Portfolio values are measured in USDC and trading costs affect the result. AudaceFi accounts for external capital movements when calculating performance. If two participants have identical performance, the smaller maximum drawdown ranks first. [Official AudaceFi Rulebook](https://audacefi.com/rulebook)

Read the rulebook's **Devnet Sandbox** section first and follow the actual rules and dates published for your season. The league is spot-only. Your strategy can use signals from another venue, then translate those signals to its approved AudaceFi spot pair and use the supported AudaceFi execution path.

Season 3 is scheduled from November 23, 2026 at 10:00 UTC to November 28 at 10:00 UTC. The published season window controls enrollment and the snapshot cutoffs. Read it from the [sandbox season timeline](https://sandbox.audacefi.app/api/v1/seasons/timeline) and check your enrolled scope with the preflight below.

| Category | Typical assets | What the bot must check |
| --- | --- | --- |
| Degen | Memecoins and micro-caps | The asset is explicitly eligible on Degen's frozen list for the active season. |
| Crypto Bro | Established tokens | The asset is explicitly eligible on Crypto Bro's frozen list for the active season. |

Enroll before the season opens. Use the league wallet registered for that category and season, and use a separate wallet if you enter both categories. Select a pair by its exact token mints and follow the season's position constraints and the limits in your approved operator setup.

## Check the frozen allowlist

AudaceFi freezes the season's list during pre-opening checks. Use your operator's API key to read `GET /v1/me/allowlist?category=degen&mode=real` for Degen or substitute `crypto_bro` for Crypto Bro. Check the exact season and category, `allowlistFrozen: true` and the asset's eligibility before sending a signal. A browser preview can show a frozen list from an earlier season before the intended season's list is ready.

SOL and USDC are allowlist exemptions in both categories. On-chain execution also needs a supported devnet mapping for each referenced token. Get the tradable SOL token mapping from `GET /v1/devnet/bench`. That SPL test asset belongs to the portfolio. Native SOL pays network fees. The ranked signal gateway selects an eligible, non-exempt spot asset for its configured USDC pair.

The server rejects a quote for a non-exempt ineligible token with `QUOTE_NOT_ELIGIBLE`. The Python preflight reports `HOLD` for an unavailable, mismatched or unfrozen allowlist. Wait for the expected season to be active and its own list to be frozen, then run a fresh preflight.

## Give your bot these decision rules

1. **Before a signal**, confirm that the expected season is active, the category and league wallet match the enrolled setup, and the configured USDC pair is permitted by the frozen allowlist. Hold the signal if the check fails or the API cannot establish current eligibility.
2. **During the season**, keep signals within the configured pair and sizing policy. The adapter's `long` enters the approved spot position and `flat` closes the tracked position into USDC. Plan exits with time to spare before the closing snapshot and reconcile fills before sending another signal. [Operator guide](OPERATOR-SIGNALS.md)
3. **At the opening and closing snapshots**, aim to hold USDC plus the native SOL gas buffer. Reconcile the whole wallet. A `flat` receipt establishes the outcome for the tracked pair.

## Snapshot cutoffs and dust

The sandbox snapshots use the scheduled opening and closing times. A later valuation or finalization does not give you more time to close a position.

For the reviewed Season 3 rules, the native SOL gas buffer may be up to 0.1 SOL. Priced non-USDC SPL balances, including tradable SPL SOL, are limited to USD 1 per mint and USD 5 in total. An unpriced residual fails the dust check. Convert positions back to USDC ahead of the deadline and keep the whole wallet within the published limits to avoid a forfeit. [Official AudaceFi Rulebook](https://audacefi.com/rulebook)

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
