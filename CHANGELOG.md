# Changelog

## Unreleased

Season 1 off-chain signal pilot, qualified for local preview only.

- Add `parseSpotSignal`, `prepareSpotSignalFromJournal`, the offline `signal:preview` CLI and a Python example for an unranked synthetic `long` then `flat` round trip.
- `prepareSpotSignalFromJournal` keeps copies of the signal and policy and invalidates earlier unreserved plans before its first journal snapshot, once the signal passes the relevance checks. A failed snapshot leaves older plans invalid. The helper checks for an unresolved operation or a run in progress before reading holdings and compares snapshots on both sides of that read. Plans expire across a module restart.
- An entry is refused unless the journal, at that moment, has an operation slot and asset budget for each of the policy's `exitAttempts` (2 to 10), each up to its `maxPositionRaw`.
- An exit larger than the remaining asset budget is refused, or, with the policy's `allowPartialExit`, sells what the budget allows and reports the rest as `residueRaw`.
- Refuse entries in assets with more than six decimal places, and position limits or asset budgets whose exits the API's JSON number could not carry exactly. These entry settings never block an exit.
- A signal plan's operation carries `limits`, applied by `runTradingBot` and `runAiAgent`:
  - an entry's `notAfterMs` is checked under the append lock immediately before the `SIGNED` write;
  - `outputDecimals` checks the received token's decimals against the verified mapping;
  - `journalVersion` refuses a plan on another journal, once anything was reserved since its snapshot, or once a newer signal passed the helper's relevance checks.
- `runOperation` tracks in-flight runs on `FileJournal`. Existing JavaScript journal adapters still support calls without a deadline or journal-version limit. Those limits require a `FileJournal` from the current kit.
- Order legacy transaction account keys like web3.js 1.98.4 `Transaction.compileMessage`, which the server rebuilds for byte comparison.

## 1.0.0

Initial AudaceFi Integration Kit source distribution for AI agents and trading bots.

- Provide an explicitly callable HTTPS client, shared guarded operator flows, durable local budgets and conservative reconciliation.
- Include a narrow devnet reference adapter with transaction construction and semantic checks, pinned deployment approval, fee/rent checks, external wallet delegation and exact finalized evidence.
- Refuse unsafe server replays and preserve uncertain or legacy journal states without allowing a replacement operation.
- Keep credentials in memory and RPC endpoint paths private. Require explicit write authorization; installation, import and local examples do not start a real connection.
- Require AudaceFi onboarding and an individual account API key for both operator types. The kit does not issue credentials or provision accounts.
- Supply synthetic tests, offline replay examples and English integration, recovery, security and support documentation.
- Qualify Node 24.22.1/npm 11.19.1 locally on Windows and Ubuntu under WSL with a native Linux temporary filesystem, including the real POSIX journal permission test.

Public source visibility, package publication and real integration qualification remain separate decisions. No active deployment, provider, wallet, mainnet or strategy result is certified by local checks.
