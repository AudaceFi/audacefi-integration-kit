# Assurance and qualification

The starter contains connection code for AI agents and trading bots, a narrow devnet reference adapter and deterministic local examples. Engineering reviews and tests are evidence within their stated scope; they do not certify a live deployment, provider, wallet, strategy performance or economic result.

## Locally qualified scope

The reference toolchain is Node 24.22.1 and npm 11.19.1, locally qualified on Windows and Ubuntu under WSL using a native Linux temporary filesystem. Type checks, synthetic tests, build, content checks and text hygiene run without product access. The Linux run includes the real POSIX journal-directory permission test; the Windows suite explicitly skips that platform-specific test. This source revision has not been qualified in GitHub Actions. macOS, other Linux environments and real provider/wallet conformance remain unqualified.

Tests exercise the client through injected transports and ephemeral local signing fixtures. The reference suite includes independent protocol, address and arithmetic vectors as well as failure, approval-expiry and ambiguous-finality cases. Builder/checker agreement alone is insufficient assurance. See [REFERENCE](REFERENCE.md) for the supported transaction forms, request bounds, supplied deployment pins and provider trust assumptions.

Both operator types must complete AudaceFi onboarding to obtain their own individual API key before any real connection. API entitlement, account session, wallet signing, server authorization and target qualification are separate requirements. Local examples need no account or key and confer no access.

## Maintainer review requirements

Before distributing a new revision or changing visibility or contribution access:

1. Run the documented controls on the exact proposed revision and obtain independent review from someone who wrote no implementation.
2. Review source, fixtures, outputs, dependencies, license notices, Git history and hosting metadata for the complete proposed disclosure. Keep private audit evidence and operator data outside this repository.
3. Reassess application access, workflow permissions, contributor permissions and the identity policy for GitHub-generated test objects. Existing development connections may process source and events independently of GitHub Actions.
4. Verify attribution and support information, and prepare the confidential reporting route. Jordan ([@buchjordan](https://github.com/buchjordan)) is the accountable maintainer. The selected route is GitHub Private Vulnerability Reporting, which GitHub offers for public repositories only, so it cannot be verified before step 5. Prepare its activation and verification sequence in advance; right after an authorized visibility change, enable it, confirm that the repository setting reports it enabled, and verify it functionally with a controlled non-personal test account. Until then, SECURITY directs reporters to an existing private contact. See [SECURITY](../SECURITY.md) for reporting limits.
5. Obtain the owner's explicit decision for public visibility. A reviewed source revision, default-branch change or passing test does not authorize merging, releasing a package, deploying or executing a real operation.

Audit conclusions apply only to their exact reviewed source revision, hosting state and stated scope. Private evidence stays outside this repository. Changes to source, access or hosting require reassessment; a passing check does not authorize public visibility or real execution.

## Real integration qualification

Operators must independently qualify their supplied deployment/profile pins, API deployment approval, RPC provider, wallet callbacks and decision policy. Supplied genesis/program equality does not certify the supplied pins themselves. An unavailable durable route blocks execution without fallback to cosign, direct RPC or an exchange executor. Preserve write opt-in, journal budgets, unresolved-operation blocking, exact-transaction reconciliation and verified finality.

Any real target test, enrollment, credential provisioning, signing or execution needs a distinct authorized scope and review. See [CONNECTING](CONNECTING.md), [RECOVERY](RECOVERY.md) and [SUPPORT](SUPPORT.md). Apache-2.0 licenses the original source; it does not grant service access or replace third-party obligations.
