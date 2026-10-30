# Changelog

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
