# Connected wire contract v1

This is a source-reviewed consumer contract, not a claim that an active deployment exposes every route. OpenAPI describes the consumed projection in [openapi.json](../contract/openapi.json); read state retains its separate JSONSchema. Unknown execution capabilities fail closed. No private product source, response or identifier is included in the starter.

## Authentication and accounts

Accounts must be declared `ai_agent` or `trading_bot` and appropriately enrolled. API keys are distinct from account sessions, wallet signing and server cosigning. Reads require `read`; mutation routes require `execute`, with server-side ownership and account-type gates. Session-only account and key-management actions are not exposed by this client. API keys travel as Bearer headers over the configured HTTPS origin, never in URLs or cookies.

## Methods and shapes

| Method | Path | Request / consumed response |
| --- | --- | --- |
| GET | `/v1/me/state` | Query category kebab-case and mode real/demo; consumes `asOf`, `mode`, `category`, `season.active`, discriminated wallet. |
| GET | `/v1/me/allowlist` | Query category snake-case and mode real; consumes season/category, frozen flag and token mint, nullable decimals, exemption and eligibility. Requires read scope. |
| POST | `/v1/swap-intents` | `seasonId` UUID, category snake-case, input/output mainnet mint identities, numeric human input amount, body idempotency key and `surface: api`. Returns `intentId`, `status: built` and boolean `replayed`. Exact ranked replay also requires the input-binding field described below. |
| POST | `/v1/swap-intents/{id}/quote` | `amountInRaw` positive u64 decimal string; single quote or `kind: route` with two leg IDs, mapping, prices, fee and expiry. |
| POST | `/v1/swap-intents/{id}/signature` | Player base58 signature; response same intention and `status: signed`. This is journaled before submission. |
| POST | `/v1/swap-intents/{id}/submit-durable` | `quoteId`, optional `quoteOutId`, player-signed legacy base64 `transaction`; returns direct durable submission proof and state SUBMITTED/RECORDED/UNKNOWN. |
| GET | `/v1/swap-intents/{id}/submission` | Envelope `{protocol, submission, resultStatus?}` under `audacefi.bench.submission.v1`. `submission` is a durable proof or null. When supplied, `resultStatus` is `confirmed`, `failed` or explicit null. Proof state `RECORDED` alone does not establish finality. |
| POST | `/v1/swap-intents/{id}/result` | Only after independent final evidence: status confirmed/failed; returns same intention/status. |

The client translates query category `crypto-bro` to intent category `crypto_bro`. The quote's `amountInRaw` must exactly match the caller's precise input units; there is no cents-to-token inference. A single quote has no wire `kind` and identifies `mintMainnet`, `mintDevnet`, `direction`, `price`, `expo`, `priceUsd`, `expiresAt`, `ttlSeconds`. Route quotes identify `mintInMainnet/Devnet`, `mintOutMainnet/Devnet`, `priceIn/Out`, `amountOutGrossRaw`, `feeRaw`, `feeBps:20`, `amountOutNetRaw` and `quoteIdOut`. Response `quoteIdOut` is sent as request `quoteOutId`.

Durable proof consumes protocol, intention and both quote IDs, message SHA256, player public key/signature, txid, recorded time and state. Full signed message and transaction bytes are not returned by the read route or retained by this client journal. SUBMITTED/RECORDED/UNKNOWN cannot become confirmed without independent final chain evidence.

Durable routes are registered only when the server capability is supplied. Missing/forbidden/unsupported routes never authorize fallback to another server signing/submission endpoint. No RPC submission fallback exists. The capability identifier is `audacefi.bench.submission.v1`; actual availability must be qualified against an authorized target before use.

## Read projection and validation

The response can include unavailable sections within HTTP200; unknown values do not become balances or execution rights. `asOf` is response assembly time. Actual market/portfolio observations and freshness remain separately qualified by the operator. Additional response fields are ignored and never logged by the projection. Wallet category is snake-case while read query category is kebab-case.

`readAllowlist(category, seasonId)` verifies the season/category context and consumes at most2048 unique token identities. It ignores unrelated metadata. The reference adapter requires matching known decimals and eligibility for both input/output assets; its observation time is read completion, not an underlying market timestamp. Read failures or unknown decimals block a plan. See [REFERENCE](REFERENCE.md) for the source-reviewed instruction ABI, integer limits and concrete account checks.

Strings use the existing maximum200Unicode-code-point profile, preserved without normalization. Timestamps use canonical four-digit-year UTC with exactly three millisecond digits and a Date roundtrip. This is the starter's consumption profile, not a guarantee about every future representation. Context/window, target mappings, price and raw-amount checks further restrict operations. The library is a trusted-code integration boundary, not a hostile-code sandbox.

## Errors and uncertainty

No raw error body or transport exception cause is retained in `ClientError`. Status is preserved as `HTTP_<number>`; timeouts, response bounds, invalid JSON, redirected origin and unsupported shapes are explicit failures. Every write failure after transmission or malformed write response remains ambiguous. A pre-send guard refusal (`GUARD_REFUSED_BEFORE_SEND`) or a deadline reached before transmission is reported as not ambiguous. The high-level flow closes the operation as `UNSENT` when its first write was refused that way. The ranked gateway preserves additional evidence at later write boundaries so an explicit replay can recover the original operation. The client sends each request once, including a request that receives HTTP 429. Read errors do not establish absence. See [RECOVERY](RECOVERY.md).

An exact ranked create replay adds `inputBinding: "audacefi.swap-intent-input.v1"` to the original admitted body and reuses its original key. The server must match the account, key, season, category, input and output mints, amount and surface against the durable intent. It echoes the marker only on a match. A missing marker or a conflict blocks continuation. For result recovery, an explicit `resultStatus: null` on a matching durable submission lets the gateway retry the same intent and finalized status after verifying the chain and current approval. An omitted field indicates a legacy server and does not authorize a result replay.
