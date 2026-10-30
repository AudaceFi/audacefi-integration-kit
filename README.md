# AudaceFi Integration Kit

TypeScript source integration for **AI agents and trading bots**. Version 1.0.0; local synthetic qualification. This repository supplies connection code, not a hosted service or a qualified live deployment.

A TypeScript integration client for operators connecting an existing **AI agent** or **trading bot** to AudaceFi. Both use the same API, state checks, durable input budgets, intention/quote/signature/submission ordering and reconciliation. The starter includes the callable connection code and local synthetic demonstrations. A deployment, an API key, a wallet signer, a model and a trading strategy are supplied and qualified by the operator; none is provisioned or run by installation.

**AudaceFi onboarding is mandatory before any real connection. Each operator must complete onboarding on AudaceFi to obtain an individual API key for its own account, whether it operates an AI agent or a trading bot.** The starter does not register an account, issue a key or provide a shared key. Cloning, installing or running the local synthetic examples grants no API access; those examples need no account or key.

## What is delivered

- Explicit HTTPS client for state, intentions, single and two-leg quotes, signature journaling, durable submission, submission lookup and final-result recording.
- `runAiAgent` and `runTradingBot`, sharing the same guarded flow. They accept an already policy-approved operation; arbitrary model text is never executed.
- An append-only local journal with exclusive reservations, payload/key binding, input-asset budgets, unresolved-operation blocking and restart-safe reconciliation metadata.
- A concrete reference adapter for the AudaceFi devnet bench: transaction construction, exact instruction/account verification, pinned deployment checks, balances, fees/rent, eligibility, external wallet callbacks and exact finalized transaction evidence. It supports BUY, SELL and token-to-token routes for both actor types.
- A bounded, read-only Solana RPC client with a separately supplied endpoint and optional RPC credential. It never submits a transaction.
- Original deterministic offline replay and synthetic scenarios, plus local-only connected lifecycle and failure tests.
- [Connection guide](docs/CONNECTING.md), [reference adapter](docs/REFERENCE.md), [operator guide](docs/OPERATORS.md), [wire contract](docs/CONTRACT.md), [OpenAPI](contract/openapi.json) and [support](docs/SUPPORT.md).

## Install and verify locally

Clone the repository and use the reviewed `stable` branch. Private repository access requires a GitHub account with permission; it does not require an AudaceFi API key. Open a terminal at the repository root, containing `package.json`. Reference tools are Git, Node24.22.1 and npm11.19.1, locally qualified on Windows and Ubuntu under WSL using a native Linux temporary filesystem. Select those tools and verify `git --version`, `node --version` and `npm --version`. Node's official release is linked in the [offline guide](docs/OFFLINE.md).

```sh
git clone --branch stable https://github.com/AudaceFi/audacefi-integration-kit.git
cd audacefi-integration-kit
npm ci --ignore-scripts
npm run check
npm run demo:bot
npm run demo:agent
```

Installation contacts the package registry. Tests, demos and build perform no AudaceFi, model, exchange, wallet or RPC requests. The full check runs types, tests, build, content review and UTF-8/text hygiene. The last two commands remain synthetic replay examples: bot gives BUY, SELL, HOLD, HOLD; agent consumes authored JSON and gives BUY, BUY, HOLD, HOLD. Each permits two hypothetical proposals, then reports `PROPOSAL_BUDGET_EXHAUSTED`, `synthetic: true`, `executionAuthorized: false`. No funds are spent. The replay is not a model or a backtest.

For negative cases, `npm run replay -- --scenario stale` and `npm run replay -- --scenario unavailable --strategy hold` return HOLD only. For the callable connected flow, start with [CONNECTING](docs/CONNECTING.md); running the quickstart never starts it.

## Integrate either operator

After building the checkout, import from `dist/index.js`. The package entry also targets that generated build; installing a raw Git revision alone does not build it automatically. Both integration functions take `OperatorCall`: an explicitly configured client, an absolute local journal directory opened with an approved budget, a closed operation and trusted ports. For the supported devnet bench, use `createReferenceAdapters` as shown in [REFERENCE](docs/REFERENCE.md). Supply the independently qualified deployment profile, approved RPC endpoint and wallet callbacks; the starter provides the builder, semantic checker, chain readers and finality checker. No provider or live profile is selected automatically. The API key is supplied through a callback in memory; no configuration file or environment variable is read by this library.

Obtain that individual key through your own AudaceFi onboarding first. Onboarding/key issuance, API scope, wallet signing and server authorization remain distinct; possessing a key alone never authorizes a trade or bypasses the required checks.

```ts
import { AudaceFiClient, FileJournal, runTradingBot, runAiAgent,
  type JournalPolicy, type Operation, type OperatorPorts } from "./dist/index.js";

interface ConnectionInput {
  origin: string;
  credential: () => string | Promise<string>;
  journalDirectory: string;
  budget: JournalPolicy;
  operation: Omit<Operation, "actor">;
  ports: OperatorPorts;
}

// Custom-port alternative; reference adapter wiring is in docs/REFERENCE.md.
export async function connectBot({ origin, credential, journalDirectory, budget, operation, ports }: ConnectionInput) {
  const client = new AudaceFiClient({ origin, credential, writes: "explicitly-authorized" });
  const journal = await FileJournal.create(journalDirectory, budget);
  return runTradingBot({ client, journal, operation, ports });
}

export async function connectAgent(args: ConnectionInput) {
  const client = new AudaceFiClient({ origin: args.origin, credential: args.credential, writes: "explicitly-authorized" });
  const journal = await FileJournal.create(args.journalDirectory, args.budget);
  return runAiAgent({ client, journal, operation: args.operation, ports: args.ports });
}
```

These functions can cause remote writes when deliberately called with real arguments. Do not call them during local qualification. The shipped tests demonstrate the same functions through an injected transport, with no external connection. Constructor/import has no I/O and writes are refused unless explicitly enabled. There is no live CLI command, scheduler, polling loop, credential loader or automatic startup.

## Qualification and boundaries

The API contract was checked against local source; the connected lifecycle is exercised against synthetic transport responses. This does **not** certify an active deployment, registration, API entitlement, provider, wallet integration, mainnet compatibility or economic result. The durable routes are optional server capabilities. Their absence blocks the workflow; no fallback to another server signing/submission endpoint, direct RPC or an exchange executor exists.

`RECORDED`, `SUBMITTED` and `UNKNOWN` are not chain confirmations. Write timeouts after transmission, malformed write replies and lost responses remain ambiguous. Reconciliation uses the exact original intention/signature; a null lookup does not authorize resubmission or a fresh key. The operator's finality verifier must identify the same transaction and pinned genesis before a final result can be recorded. Read [recovery](docs/RECOVERY.md).

The reference adapter implements the ports for a narrow, source-reviewed protocol profile; custom ports remain possible and require their own review. Profile pins and API deployment approval are supplied by the operator: equality with supplied values does not prove that a network is devnet or that the approved server implements the durable routes. Actual deployment/provider/wallet qualification remains necessary. This is a trusted-code integration boundary: never feed model-generated code, endpoints, credentials or transaction bytes into it. Maintainers review the exact revision and [assurance boundaries](docs/AUDITS.md) before distribution or changes to access. Every real integration still needs its own deployment, provider and wallet qualification.

## License

Original source and documentation use [Apache-2.0](LICENSE); dependencies retain their own terms. No license supplies service access, accounts, credentials or trademark rights. `private: true` and a publication guard prevent accidental npm publication; source-hosting visibility is a separate decision. Making source available does not publish an npm package or authorize any live operation.
