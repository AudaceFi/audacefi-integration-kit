# AI agents and trading bots

Both `ai_agent` and `trading_bot` operators use the callable client and the same guarded execution protocol. The distinction is the source of a policy-approved decision. Existing agent/model and bot strategy code stay under the operator's control. The starter neither hosts a model nor imports an existing bot executor.

For either actor, **AudaceFi onboarding is mandatory to obtain an individual API key for its own account before any real connection**. The starter supplies no shared key and does not enroll accounts or generate credentials. Local synthetic demos are account-free and key-free; running them does not provide API access. The individual key still needs the appropriate scope and never replaces the player signature or target/plan checks.

| Actor | Integration entry | Responsibility before the call |
| --- | --- | --- |
| Trading bot | `runTradingBot(OperatorCall)` | Convert a strategy signal into a policy-approved, precisely denominated operation; retain the strategy's risk checks. |
| AI agent | `runAiAgent(OperatorCall)` | Treat the model response as untrusted data, validate a closed decision and apply policy before constructing the operation. |

For both: follow [CONNECTING](CONNECTING.md) and use the same journal and reconciliation. The [reference suite](REFERENCE.md) supplies concrete target/plan checks, transaction construction and finality for the supported devnet bench. Supply the independently qualified profile, RPC endpoint and player wallet callbacks, or separately review custom ports. A bot's existing exchange/wallet executor must not bypass AudaceFi's intention/quote/server submission path. A model cannot select credentials, endpoint, executable code, signing policy or raw transaction bytes.

## Local examples

```sh
npm run check
npm run demo:bot
npm run demo:agent
```

The original bot demo is a small deterministic signal rule, producing BUY, SELL, HOLD, HOLD. The agent demo consumes authored JSON, producing BUY, BUY, HOLD, HOLD, without inference. Both use bundled `fresh` data, stop at two hypothetical proposals and retain `synthetic: true`, `executionAuthorized: false`. Their `spentCents` counts simulated notional reservations only; no funds are spent. These are examples, not profitable strategies or real backtests.

The complete check also exercises both connected operator functions using only injected synthetic API/RPC transports, ephemeral local signing data and a temporary journal. Tests include exact protocol ordering, lost-response recovery, fixed budgets after reopening, changed payload/key refusal, expired state/quote/approval/blockhash, wrong payer/mapping/program/signature, unknown submission and withheld finality. The concrete reference suite is exercised for both actors and all three trade forms. No product endpoint or wallet is contacted. Test harness profiles, keys and responses are fixtures, never deployment configuration. The reference suite's real provider/profile/wallet wiring remains separately qualified; tests do not establish a working real connection.

Account type is distinct from category (`degen`, `crypto-bro`, `whale`), strategy and API mode. An operation does not declare or enroll an account. Account setup and permissions must already be established through the normal account/session process. The client never accesses unrelated private application modules.
