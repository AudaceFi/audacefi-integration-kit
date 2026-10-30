# Deterministic offline replay

Inputs are bundled synthetic frames. The command accepts only named scenarios and strategies, not paths, URLs, API keys or live flags. No environment, home-directory configuration, dotenv file or SDK credential cache is read.

## Defaults and expected results

Both `demo` and `replay` default to scenario `fresh` and strategy `baseline`. Setting only `--strategy model-fixture` therefore keeps scenario `fresh`; setting only `--scenario stale` keeps strategy `baseline`. Risk guards run before a strategy can propose anything, so the unavailable-wallet example reports `WALLET_UNAVAILABLE` even with strategy `hold`.

The explicit operator examples `demo:bot` and `demo:agent` select `baseline` and `model-fixture`, respectively, both with scenario `fresh`. They are aliases over this same guarded replay, not new execution modes or account declarations. See [both operator paths](OPERATORS.md).

The [README local verification section](../README.md#install-and-verify-locally) describes the bot, agent, stale and unavailable quickstart results. The two examples with proposals each have `proposalCount: 2` and `spentCents: 2000`. Here `spentCents` totals hypothetical notional reservations in integer USDC cents; no money was spent. The stale and unavailable examples have both counters at zero. npm prints a command banner before the JSON object.

## Evidence and budgets

The source-reviewed API response projection is separated from the starter-owned synthetic market/portfolio observations. Numeric money fields are nonnegative safe **integer USDC cents**, not floating token quantities. The market `signalBps` is an authored example signal, not a quoted API indicator or trading recommendation.

Every new frame requires an active devnet_onchain season, a coherent wallet/category/mode/window and independently fresh state assembly, portfolio and market observations. Default fixture age is120s, future skew30s: these are explicit offline test parameters, not a statement of platform freshness policy. Unknown balances remain unknown. Invalid input structure rejects the replay; valid but insufficient evidence produces HOLD with a reason.

Baseline, hold and model-fixture use the same risk guards. Model JSON is a closed flat object: HOLD only, or BUY/SELL with mint and positive integer amountCents. Unknown fields/actions, duplicate keys, fractional/negative/nonfinite amounts and oversized text are refused. No arbitrary prompt, command, tool or network operation is evaluated.

Limits apply to the complete in-memory replay: amount per proposal, total proposed notional and proposal count. BUY reserves synthetic cash and SELL reserves synthetic position value, without mutating input observations or claiming a real holding changed. Holds and duplicate frames consume no proposal budget. Same frame ID+same normalized input is a duplicate; same ID+changed input rejects the replay. New frame clocks cannot regress. Starting a new process starts a NEW simulation with explicitly fresh counters; this is not a durable live admission journal.

Canonical formatv1 sorts object keys. Allowlist and positions are normalized to lexical order; replay frame order remains meaningful. Arrays otherwise retain order. Undefined/nonfinite values are rejected. SHA256 binds the consumed projection, complete validated configuration, strategy, simulated clock and optional raw model-reply text. Ignored API properties are not retained or bound. Whitespace inside raw model text remains part of the input. Each entry's `inputDigest` identifies that frame's normalized consumed input together with the validated configuration and strategy; the top-level `digest` binds the complete result. For identical bundled data, configuration and strategy on the same revision, reruns must retain the same entry input digests and result digest. A change to consumed evidence or strategy can change these values. They are comparison hashes, not signatures, authorization or proof of economic performance. There is no Date.now, random UUID or wall-clock dependency in decisions.

No token PnL, price simulation, chain finality or economic performance is inferred from proposals. The network guard blocks common outbound/listening APIs before a request; Node permissions deny process/worker/addon capabilities and restrict file reads to this repository when launched through the supplied commands. Neither this preload nor source scanning is a security boundary for adversarial code or a compromised Node binary. Do not add plugins or remove the wrapper to obtain a live mode.

## Connected library boundary

This guide describes only the deterministic offline replay. The separately callable connected client and agent/bot flows are described in [CONNECTING](CONNECTING.md). Importing them does not change the CLI commands, fixture meanings or executionAuthorized:false replay marker. Those markers must never be attached to a real submission result. Tests remain network-denied and inject synthetic transports; an actual connection needs its own explicit caller configuration and authorization.

Reference runtime: [Node24.22.1 official release](https://nodejs.org/en/blog/release/v24.22.1).
