# AudaceFi devnet reference adapter

`createReferenceAdapters` supplies target checks, a concrete transaction builder, semantic verification, wallet delegation and finality verification for the source-reviewed AudaceFi bench protocol. Both `runAiAgent` and `runTradingBot` use the same suite. Import and construction are inert. No real endpoint, wallet provider, credential or executable strategy is bundled.

**Complete AudaceFi onboarding to obtain the individual API key for your own account before any real connection, for either actor type.** Installation and synthetic tests grant no access. The API key, optional RPC credential, player wallet and AudaceFi server cosigner are distinct authorities.

## Wiring in your reviewed application

Build first, then import from `dist/index.js`. This function is an integration example, never called by installation or the demos. Calling its returned operator with real configuration can read services, request a player signature and cause API writes; such use needs separate qualification and authorization.

```ts
import { AudaceFiClient, SolanaRpcReader, createReferenceAdapters,
  runTradingBot, runAiAgent, finalizeOperation,
  type BenchProfile, type WalletPort, type FileJournal,
  type Operation } from "../dist/index.js";

export function wireOperator(input: {
  profile: BenchProfile;
  apiCredential: () => string | Promise<string>;
  rpcEndpoint: string;
  rpcCredential?: () => string | Promise<string>;
  wallet: WalletPort;
}) {
  const client = new AudaceFiClient({ origin: input.profile.apiOrigin,
    credential: input.apiCredential, writes: "explicitly-authorized" });
  const rpc = new SolanaRpcReader({ endpoint: input.rpcEndpoint,
    ...(input.rpcCredential ? { bearer: input.rpcCredential } : {}) });
  const adapters = createReferenceAdapters({ profile: input.profile,
    client, rpc, wallet: input.wallet });
  return {
    bot: (journal: FileJournal, operation: Omit<Operation, "actor">) =>
      runTradingBot({ client, journal, operation, ports: adapters.ports }),
    agent: (journal: FileJournal, operation: Omit<Operation, "actor">) =>
      runAiAgent({ client, journal, operation, ports: adapters.ports }),
    finalize: (journal: FileJournal, operationKey: string) =>
      finalizeOperation(client, journal, operationKey, adapters.verifyFinal),
  };
}
```

Open the journal separately with an approved fixed input budget and controlled absolute directory; see [RECOVERY](RECOVERY.md). `WalletPort.publicKey()` returns the current player's base58 public key. `signTransaction(unsignedBase64)` returns the same legacy transaction with only the player's Ed25519 signature added. The wallet manages its own key and user approval. The starter does not load private keys, select a wallet, authorize a trade or produce the server signature. Wallet refusal, key change, extra signature or message mutation stops the flow conservatively.

## Deployment profile and trust

Supply every `BenchProfile` field through reviewed application configuration. No profile file loader or default live profile is provided.

| Field | Required qualification |
| --- | --- |
| `apiOrigin` | Exact approved HTTPS origin, matching the client. No paths, credentials or query. |
| `expectedGenesis` | Independently established genesis of the authorized devnet target. The reader checks equality, not the external classification of that value as devnet. |
| `programId`, `programData`, `programDataSha256` | Authorized upgradeable bench program, its ProgramData account and SHA256 of the **entire raw ProgramData account**, including metadata. Upgrade or metadata change invalidates the pin. |
| `admin`, `poster`, `freshnessSeconds` | Expected bench configuration and server price-poster identity. Freshness must be1..86400seconds. |
| `usdcMainnet`, `mappings` | USDC identity and unique mainnet identity/devnet mint pairs with verified0..9decimals. Between2and64 mappings. |
| `apiApproval` | Operator attestation of a separately qualified API deployment: protocol `audacefi.bench.submission.v1`, `validFromMs` and `expiresAtMs`. The adapter checks the window, including after waits. It does **not** discover or certify server route availability from this attestation. No automatic renewal. |

The reference suite clones and freezes this profile. Keep endpoints, clocks, application code, transports and wallet callbacks within your trusted deployment boundary. Replacing them with malicious functions defeats the trust model. An approved provider can still give incorrect responses; this reader does not implement consensus verification. Do not derive trust pins from the same untrusted response being checked. The current profile supports only a deliberately approved devnet bench, never a generic network or mainnet executor.

## Concrete supported protocol

The builder emits legacy transactions with exactly two writable signer slots: player fee payer and the configured server poster. Instruction order is idempotent output associated-token-account creation, one or two `post_price` instructions bound to the quote, then `swap` or `swap_route`. BUY/SELL charge10basis points in USDC; token-to-token route charges20basis points in the output token. Integer arithmetic follows checked u128 intermediates, floor division and positive u64 results. Route gross/fee/net must match the quoted amounts exactly.

The semantic checker decodes the final message and checks exact instruction data, account order, mapped mints, signers, payer and privileges after transaction-wide union. It refuses extra instructions, changed prices or amounts, privilege escalation and unknown builds. Builder and checker share the declarative protocol plan; independent review and independently computed ABI/math/PDA vectors are required assurance beyond their mutual agreement.

Each target/plan snapshot checks pinned genesis, upgradeable program and ProgramData hash, bench configuration, classic SPL mints, monotone finalized context slots and the Clock sysvar. Plan checks also require initialized, unfrozen, undelegated classic SPL accounts, sufficient input balance, output liquidity, pre-existing fee vault, player fees/output-account rent and poster rent for absent price accounts. Each paying system account must also keep its own rent-exempt minimum; a zero final balance is not assumed. They verify blockhash validity and last valid block height. Existing price-account data is checked for identity; quote-bound `post_price` instructions replace its price. This does not supply fresh market data for the operator's strategy.

The API state must identify the active devnet-onchain season, wallet and operation context. `/v1/me/allowlist` supplies an additional consumed eligibility projection: both assets must have matching known decimals and be exempt or included in a frozen eligible set. This conservative reference requirement can refuse cases accepted elsewhere. Allowlist observation time is completion of that read, not a market-data timestamp. The on-chain bench alone does not enforce this API season/allowlist policy.

Before asking the wallet for a signature and after it returns, and immediately before each signature/submission API transmission after credential resolution, the suite refreshes plan evidence. These checks reduce stale observations but cannot remove changes after the last check or guarantee server/on-chain acceptance. The server remains responsible for its own authorization, price/quote binding and submission checks.

Only classic SPL Token, its standard associated accounts and the pinned upgradeable bench are supported. No Token2022, address lookup tables, versioned transactions, compute-budget/priority-fee additions, wallet message rewriting, arbitrary instructions, fee-vault creation, enrollment, direct RPC submission or exchange fallback is provided. Unsupported shapes fail closed.

## Resource and transport bounds

`SolanaRpcReader` accepts one explicit HTTPS endpoint without userinfo, query or fragment, with an optional separate bearer callback. Prefer that callback to a provider token in the path: the full endpoint stays private and only its `origin` is exposed, but a path token still travels in every request URL. It permits only the nine implemented read methods. Defaults are a10second deadline and2MiB response cap, configurable within constructor bounds (at most60seconds and4MiB). Credentials, transport and response-body time are bounded. Requests omit cookies, refuse redirects and bind JSON-RPC response IDs; errors discard raw bodies and causes. Import/constructor sends nothing. An injected `RpcPort` must preserve these guarantees itself.

A complete successful operation performs five full plan verifications, including one inside the wallet adapter after obtaining its public key. With absent output/price accounts, the bounded path uses at most49RPC reads and15API requests before finalization. One explicit finalization adds at most4RPC reads and2API requests: **53RPC reads and17API requests total** for this path. Synthetic tests check this bound. Account snapshots are limited to100accounts; the build cache holds at most8 plans, with a120second age limit checked during explicit calls. No background eviction, retry, polling or scheduler exists.

These calls may consume provider quotas or trigger server-side metadata work in a future real integration. Qualify latency, timeouts, quotas, costs and server/executor budgets before such use. Slow guards can exhaust an API request deadline and safely refuse transmission. Repeated calls, manual reconciliation or operator scheduling incur additional reads; the per-path bound is not a global rate or spending limit. None of those services was contacted during local qualification.

## Finality and remaining qualification

`verifyFinal` checks the exact stored signature and message against finalized status and transaction data, matching slot/error, both Ed25519 signatures and pinned genesis before and after the reads. A recognized definitive chain error becomes failed; malformed, unknown, missing or unfinalized evidence stays unknown. Supported error variants are deliberately closed, so future variants may require a reviewed update. No polling or replacement is inferred from unknown. See [RECOVERY](RECOVERY.md).

Local synthetic qualification covers both actors and BUY/SELL/route, including corruption, overflow, expired approval/quote/blockhash, wallet delay/mutation, eligibility changes and finality uncertainty. It does not qualify an active API deployment, actual devnet profile, account, provider, wallet, filesystem power-loss behavior, market data or economic result. Public opening, GitHub security-channel eligibility/verification and real integration approval remain separate [gates](AUDITS.md).
