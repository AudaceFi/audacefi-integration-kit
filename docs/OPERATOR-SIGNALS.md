# Connect your bot or agent to AudaceFi

An external strategy sends a small signal to the kit. The kit turns an approved `long` or `flat` into a spot operation in an AudaceFi Crypto Bro or Degen season on Solana devnet. Any language can produce the signal. The source strategy can run off-chain and can trade futures, options, prediction markets or other instruments in its own venue.

Use the [league rules guide](LEAGUE-RULES.md) to give the strategy the competition objective, snapshot requirements and category rules. Its Python preflight checks the season, wallet and pair against the API before the strategy emits a signal.

## Season 3 and the official gateway

The official `signal:live` and `signal:http` targets require the AudaceFi-issued deployment profile and signed approval. That package is pending. The [Degen validation procedure](ADAPTER.md#degen-validation-operator) covers isolated qualification before enabling the official target.

`runTradingBot` and `runAiAgent` are the lower-level TypeScript entry points for a qualified API and durable server submission. The Season 3 sandbox bench can supply cluster, program and mint mapping data through `GET /v1/devnet/bench`. A write target also needs independently verified program and fee information. The kit's official proxy adapter expects a reviewed 20 bps program and an account response confirming `read` and `execute` scopes. As checked on November 22, 2026, the Season 3 deployment serves the 10 bps direct-swap program and lacks that scope response and the per-intent ranked-evidence route. The kit's direct TypeScript flow needs deployment qualification before operators can use it for ranked Season 3 execution.

For Season 3 onboarding, use the [league wallet guide](CONNECTING.md#link-and-enroll-a-league-wallet) and run the [read-only preflight](LEAGUE-RULES.md#check-the-league-before-sending-a-python-signal) once the enrolled season is active. Keep strategy execution on a compatible, separately qualified target.

## Set up your AudaceFi operator

1. Complete the standard [AudaceFi signup](https://sandbox.audacefi.app/join) as a `trading_bot` or `ai_agent`. Link the operator-controlled Solana wallet for your chosen category and enroll it before the season starts. Obtain your account's individual API key with `read` and `execute` scopes. The approved `GET /v1/me` returns your account UUID as `account.id`. Use the enrolled season UUID and wallet public key supplied by your season setup. See [Connecting an operator](CONNECTING.md).
2. Use the official deployment profile and issuer public key supplied separately by AudaceFi. It binds the API origin and `/api` path, Solana devnet, the exact deployed program and ProgramData, the 20 bps spot fee and the submission protocol. Choose one spot asset on the season's frozen allowlist, set an entry allocation and budget, and reserve a local journal for this strategy and wallet. Start with a reconciled zero position for that pair.
3. In an operator-owned `.mjs` module outside the checkout, export an [`OfficialRankedSignalSetup`](../src/ranked-signal.ts) as the default export. The `api` field takes the reviewed origin and your API-key callback. Use [`SolanaRpcReader`](../src/rpc.ts) for the reviewed read-only devnet RPC. Connect a [`WalletPort`](../src/reference.ts) to your own wallet's reviewed signer. `publicKey()` returns the registered wallet and `signTransaction(unsignedBase64)` returns the unchanged legacy transaction with only the player signature added. Browser wallet linking uses the standard AudaceFi session. Keep signer material inside the operator's wallet boundary. The kit checks the program, account and pair and uses AudaceFi's server for submission and cosignature. [Profile and signing requirements](REFERENCE.md)

This entry point requires a separately qualified league deployment. The [isolated validation guide](ADAPTER.md) covers the test profile. The [offline preview](SIGNAL-PILOT.md) is available immediately without an account.

Set `category: "degen"` in the trusted operator module for Degen. Omitting `category` selects Crypto Bro, which can also be set explicitly with `"crypto-bro"`. The category comes from the operator module and is bound to the approval and journal scope. In either category, your signal producer uses the same payload format.

The module below uses Degen with reviewed deployment and wallet bindings. `operator-bindings.mjs` is your own module, outside the kit checkout.

```js
import { SolanaRpcReader } from "/absolute/audacefi-integration-kit/dist/index.js";
import {
  profile, rpcEndpoint, wallet, readApiKey, officialApproval, assertOfficialTarget,
  actor, accountId, seasonId, playerPublicKey, pair, journalDirectory,
  entryBudgetRaw, exitBudgetRaw, signalHttpToken,
} from "./operator-bindings.mjs";

export { signalHttpToken };

export default {
  category: "degen",
  api: { origin: profile.apiOrigin, credential: readApiKey },
  rpc: new SolanaRpcReader({ endpoint: rpcEndpoint }),
  wallet, profile, officialApproval, assertOfficialTarget,
  actor, accountId, seasonId, playerPublicKey, pair, journalDirectory,
  source: "my-strategy",
  journalPolicy: {
    maxOperations: 1 + pair.exitAttempts + pair.recoveryExit.attempts,
    inputBudgets: { [profile.usdcMainnet]: entryBudgetRaw, [pair.assetMint]: exitBudgetRaw },
  },
};
```

The `pair` defines `symbol`, `assetMint`, `maxEntryBps`, `maxPositionRaw`, `exitAttempts` and `minimumFlatOutRaw`. The official gateway requires `recoveryExit` with `attempts` and a separately approved `minimumOutRaw` at or below the ordinary floor. The two attempt counts together must be at most ten. Budget one entry plus both kinds of exits, with at least `(exitAttempts + recoveryExit.attempts) × maxPositionRaw` in the asset budget. Amount and budget fields use decimal strings in each token's raw units. Keep one journal per strategy and wallet. The supervised recovery command can access the capacity reserved for it, subject to the same target, balance, signature and submission checks.

Official activation requires a qualified deployment and an approval package issued by AudaceFi. The public kit includes an offline preview and the integration interfaces. Use the independently verified release package for `officialApproval.issuerPublicKey`, `expectedEvidence` and `deploymentDigest`. The kit exports `officialApprovalDeploymentDigest(expectedEvidence)` for matching the evidence manifest. Use `officialApproval.read(signal)` for the current signed approval and `officialApproval.isCurrent(payload, signal)` for its live status through the issuer channel. Each approval callback, including `assertOfficialTarget(signal)`, gets an abort signal and a five-second deadline. Keep callbacks asynchronous, read-only and abort-aware. The gateway checks signed evidence and current approval before writes. AudaceFi's server authorization remains a separate control.

Approvals last at most one hour. A new operation needs at least two minutes remaining in both the approval and profile windows. In `assertOfficialTarget`, verify the enrolled account and wallet, current season and execution window, frozen allowlist, finalized opening snapshot and the approved independent exit. Use the live release identifiers from the reviewed deployment. After a service-only redeploy, obtain a new current approval with its new release evidence and restart the gateway with the same journal, source and exact saved signal bytes. A change to the chain profile, operator scope, frozen allowlist or opening snapshot requires a separately reviewed recovery plan for any open position.

For Degen, confirm that the deployed API admits the enrolled operator and reports ranked evidence in that category. Qualify the selected Degen pair in an isolated validation season before enabling the official gateway. Use a separate journal and run directory from Crypto Bro, and confirm that both spot legs are finalized and included in the matching Degen ranking. The [validation procedure and Degen operator template](ADAPTER.md#degen-validation-operator) cover the required inputs and receipt checks.

## Operate in both categories

Set up two separate operator configurations. Link and enroll each wallet for its own category, then run the preflight separately with the corresponding settings.

| Configuration | Category | League wallet | Journal directory |
| --- | --- | --- | --- |
| Crypto Bro strategy | `crypto-bro` | Your enrolled Crypto Bro wallet | `/absolute/journals/crypto-bro` |
| Degen strategy | `degen` | Your enrolled Degen wallet | `/absolute/journals/degen` |

Use each configuration's own spot pair, signer's wallet, journal and saved signals. If using loopback HTTP receivers, assign each receiver its own port and run scope. Run the preflights close to the strategy decision and use the season window returned by the API.

## Translate your strategy's decisions

Map an exact instrument identifier to an eligible AudaceFi spot symbol selected by your policy. An identifier can include the venue, expiry, strike, option right or prediction-market outcome. For example, you might configure a specific futures contract or a specific market outcome as a trigger for `long` on a separately selected spot pair. Your strategy defines when that exposure should turn on or off. Broker contract size, leverage, option direction and prediction-market prices do not determine AudaceFi sizing. `flat` closes the verified spot position into USDC. An unsupported decision or an unmapped instrument fails closed.

Signal entries and exits support token precision through nine decimals when the API number maps back to the exact raw units. Small exact amounts still need a valid quote and enough output under the operator's exit policy. Both the direct client and the signal path retain their configured amount and budget checks. [Signal precision and exit rules](SIGNAL-PILOT.md#precision-and-exit-capacity)

Use the canonical uppercase spot symbol in raw JSON Lines and the configured pair. Aliases such as `$WIF`, `LMAO!` and `OLD SLERF` can be represented. The Python helpers normalize supported labels to uppercase. Confirm that the current allowlist resolves the symbol uniquely to the approved asset mint.

The [Python helper](../examples/signal_http_client.py) emits the same [JSON Lines signal](SIGNAL-PILOT.md#send-a-signal-from-another-bot) for every source. Supply `previous` from the last matching ranked receipt and `current` from your strategy's confirmed decision. The helper supports `long` and `flat`. Explicitly set `short_to_flat=True` if your strategy should close a previously confirmed long on a short decision. A short from flat is refused. Save the exact payload before delivery and advance your state only on the matching ranked receipt.

```python
from signal_http_client import prepare_strategy_transition

payload = prepare_strategy_transition(
    source_instrument, approved_spot_symbols,
    previous=last_ranked_state, current=strategy_decision,
    signal_id=event_id, sequence=next_sequence,
    target_bps=approved_entry_bps, expires_at_ms=expiry_ms,
)
if payload is not None:
    save_before_send(event_id, payload)
    send_to_gateway(payload)
```

`save_before_send` and `send_to_gateway` are your strategy's persistence and delivery functions. Use one producer and one gateway per journal. See the [broker examples](BROKER-POSITIONS.md) for successful snapshot requirements and the [Python HTTP client](PYTHON-HTTP.md) for sending and reconciling the saved bytes.

## Start the gateway

Use the official commands below once you have the issued approval package and have qualified the deployment.

Install the locked dependencies and build the checkout with `npm ci` and `npm run build`. Pipe scope-bound JSON Lines from your existing strategy, or start the authenticated loopback receiver for local HTTP clients. The [CLI framing](ADAPTER.md#send-signals) uses the saved `runScope` and the exact signal text in each line.

```sh
your-signal-producer | npm run --silent signal:live -- --execute --operator /absolute/operator.mjs --target official
npm run signal:http -- --execute --operator /absolute/operator.mjs --port 8787 --target official
```

For HTTP, export a separate `signalHttpToken` of 32 to 128 URL-safe characters from the operator module and pass it to local signal producers. Use authenticated `GET /scope` when starting a new run. Persist that scope with each signal and send it in the `X-AudaceFi-Run-Scope` header on `POST /signal`. The AudaceFi API key and wallet callback stay in the operator module. Only one of these commands should own a given journal. See [HTTP authentication and recovery](PYTHON-HTTP.md).

The [supervised Python example](ADAPTER.md#send-signals) also accepts `--target official`. Use a fresh run directory when starting in a different scope. The example records an opaque binding to the target, account, wallet, season, category, program, pair, journal directory and journal policy before sending its first signal. Resume with the same run directory and intact journal. Preserve any saved signals if the scope cannot be verified, and reconcile them before starting a new run.

The gateway returns `ranked: true` after checking finalized chain evidence and an authenticated server receipt that identifies the same indexed fill. The server supplies the provisional rank and valuation timestamp. The fee is floored in raw USDC, so gross amounts below 500 raw units pay zero. A pending or review receipt includes the operation key for reconciling the same saved signal. Keep the journal and resolve the existing operation before generating another ID. Ranked evidence also requires a materialized division and a movement history within the server's 512-movement limit. [Recovery](RECOVERY.md)
