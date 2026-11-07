# Ranked Crypto Bro validation from Python

This adapter runs a supervised `long` then `flat` on one spot pair in a dedicated Crypto Bro validation season on Solana devnet. Both legs use 20 basis points of simulated USDC fees. The operator provides the validation deployment and wallet callback. The public [offline preview](SIGNAL-PILOT.md) runs with no account, credential, or wallet.

## Prepare a validation operator

1. Use an identified `trading_bot` or `ai_agent` account, its individually issued API key with `read` and `execute` scopes, and its dedicated, enrolled wallet. The wallet owner signs the reviewed transaction message. AudaceFi authorizes the submission and cosigns on the server. Keep the account key, signer implementation, target profile and journals outside the checkout.
2. Review the exact code revision and prove isolation from official standings and rewards. Confirm a fresh active Crypto Bro season, a valid opening snapshot, and working trade indexing and ranking. Pin the devnet genesis, program and ProgramData hash, authority, poster, mint mappings, and submission protocol. Review the program that charges 20 bps on both spot legs before pinning it.
3. Create a trusted `.mjs` operator module with a default export matching [`RankedSignalSetup`](../src/ranked-signal.ts). Supply a write-authorized `AudaceFiClient` with an injected transport bound to the isolated validation API. The logical origin is `https://audacefi-ranked-validation.invalid`. Supply the separately scoped read-only RPC port, external wallet callback, a dedicated absolute local journal directory, and fresh target attestation. The attestation must bind the exact validation season, account, wallet, deployment and ranking perimeter. Use a local filesystem with durable writes and operator-only access.
4. Choose one eligible, non-exempt spot asset with at most six decimals. Match the selected symbol to the season's frozen `/v1/me/allowlist` and independently pin the asset and USDC mint mappings. The configured entry percentage, raw input budgets, position cap and minimum flat proceeds are the operator's limits. Leave two exit attempts in the journal budget. Begin with zero of the asset and reserve the wallet for this run.
5. Supply a [ranked evidence reader](../src/ranked-proof.ts) that can link the exact finalized intent and signature to an indexed fill and to inclusion in a specific ranked leaderboard row. An aggregate row and a separate transaction lookup do not establish inclusion. The reader also provides the authoritative raw input, output and fee. Bound its waits and keep it confined to the validation environment.

## Send signals

Build the reviewed checkout with `npm run build`. Use a new operator-only run directory for each pair of signals. The example binds the directory to the gateway's scope before saving or sending a signal. Resume with the same run directory and intact journal. A scope mismatch or a legacy directory with saved signals and no scope marker requires operator review. Keep those files for reconciliation.

```sh
python3 examples/ranked-signal.py \
  --operator /absolute/path/to/validation-operator.mjs \
  --run-dir /absolute/path/to/operator-state/run-001 \
  --symbol APPROVED_SYMBOL --target-bps 1
```

Use the exact symbol selected in the approved operator module. The example waits for the long leg to be finalized, indexed and ranked. It then sends a fresh flat signal. A successful flat receipt includes `positionAfterRaw: "0"`. Both ranked receipts include the operation key, intent and transaction signature, observed fee, division, rank and ranking timestamp. Preserve the receipts privately and check the validation leaderboard separately.

Other local programs can send a JSON Lines stream to the same gateway. Each line is an object with `runScope` and `signal` string fields. `signal` is the exact [signal JSON text](SIGNAL-PILOT.md#send-a-signal-from-another-bot), without its trailing line delimiter. Read the scope with `--emit-ready-scope` at the start of a new run and save it with each signal. Replay the saved scope and signal together after a restart. The `ready` message describes the local transport, and eligibility is checked before admitting the operation.

```sh
your-signal-producer | npm run --silent signal:live -- --execute --operator /absolute/path/to/validation-operator.mjs
```

The CLI returns one JSON receipt per line. Keep the stream local and give only the trusted signal source access to it. `long` uses the selected share of the available USDC balance. `flat` sells the exact position verified from the earlier ranked fill. Unmapped symbols, duplicate symbols, shorts, expired new signals and non-increasing sequences are refused. The bot never maps a broker instrument to a token implicitly.

### Local HTTP receiver

The same validation operator can opt in to a loopback HTTP endpoint. In the trusted operator module, export `signalHttpToken` as a separate randomly generated secret of 32 to 128 URL-safe characters. Keep it in operator-owned storage, give it only to authorized local signal sources, and keep it out of the URL, JSON body, command-line arguments and logs. The module still supplies its existing default export.

```sh
npm run signal:http -- --execute --operator /absolute/path/to/validation-operator.mjs --port 8787
```

Read the authenticated `GET /scope` once per new run. Save the returned scope with each payload. Send `POST http://127.0.0.1:8787/signal` with `Content-Type: application/json`, `Authorization: Bearer <signal token>`, the saved `X-AudaceFi-Run-Scope` and the exact `Content-Length`. Send one UTF-8 JSON signal of up to 512 bytes without a line ending. An HTTP client can calculate the length from the body bytes.

Use the [standard-library Python client](PYTHON-HTTP.md) to send a saved signal from a local bot. The bot supplies its own explicit instrument mapping and stable signal identity.

The receiver handles one request at a time and waits for the gateway's receipt. HTTP `200` carries the gateway's status, which can still be pending. A busy receiver returns `429` with `Retry-After`. Body upload has a three-second limit. A gateway error or a 60-second response deadline returns `status: "unknown"`. The gateway can still be working after a response deadline. Keep the exact original signal for reconciliation and wait for the receiver to become available. The receiver holds its only slot until the gateway settles and reports no queue acceptance.

Use a single ingress process per validation journal. The HTTP receiver binds only to `127.0.0.1` and requires the corresponding Host header. It serves local scripts and bots. TradingView requires an externally reachable endpoint and cancels requests that exceed three seconds. A TradingView integration would need a separately reviewed HTTPS ingress with authentication and durable acceptance. [TradingView webhook configuration](https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/)

## Reconcile a run

`finality-pending` and `ranking-pending` indicate that the exact signal can be checked again. The Python example backs off between those checks. API rate limits and other request failures can require operator review. Reusing the saved signal only reconciles its existing operation. A changed payload with the same ID or sequence is refused. Unknown submission results never trigger another trade or a replacement ID.

`review-required` or a rejected response means the operator must inspect the journal and any saved intent or submission. A failure between saving the signal and reserving its operation can leave the inbox blocked before there is an intent. Preserve the inbox and journal for operator review. A crash can also leave a lock file. Verify that the original process is stopped and inspect durable records before handling the lock. If the final-result write may have been sent, establish its server state before making any further write. Keep the same journal and saved signals when resuming. See [recovery](RECOVERY.md) for the operator procedure.

The current validation entry point supports a local Python, JSON Lines or HTTP producer. A ranking outage pauses the sequence with the position open for operator review. External webhook delivery, broker-specific bridges, automatic closing and official-season onboarding require their own reviewed integration.

## Read account-scoped evidence on a reviewed deployment

`AudaceFiClient.readRankedEvidence(request)` reads the proposed `audacefi.bench.ranked-evidence.v1` contract from `GET /v1/swap-intents/{id}/ranked-evidence`. The API key needs read scope. A deployment using the same-origin `/api/v1` proxy can set `apiBasePath: "/api"` on a dedicated read-only client. The client pins its HTTPS origin and path at construction. Validation execution uses its existing `/v1` deployment path.

The response must match the requested account, season, wallet, operator type, intent, signature, and operation key. The leaderboard entry must identify the same included trade. The caller still checks finalized chain evidence and the operation journal. An explicit pending response can be polled. The reader honors one valid, short `Retry-After` delay for a rate-limited read. Longer delays and a second failure are returned to the operator. Writes retain their existing reconciliation rules.

Use this reader after the target deploys and qualifies the evidence endpoint. The default Python target uses the dedicated validation profile. The explicit official target is described in the [operator guide](OPERATOR-SIGNALS.md).
