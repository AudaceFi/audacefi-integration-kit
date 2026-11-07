# Assurance and qualification

The kit contains connection code for AI agents and trading bots, a narrow devnet reference adapter, ranked gateway code and deterministic offline examples. Engineering reviews and tests establish behavior for the exact reviewed revision and test environment. Live deployment, provider, wallet, strategy and economic performance require separate qualification.

## Locally qualified scope

The reference toolchain is Node 24.22.1 and npm 11.19.1. Type checks, synthetic tests, build, content checks and text hygiene run without product access. Use a native Linux temporary filesystem for a full Ubuntu run under WSL, including the POSIX journal-directory permission test. The Windows suite skips that test and needs permission to create directory junctions for the filesystem hygiene tests. Record the platform and test results for the exact proposed revision.

Tests exercise the client through injected transports and ephemeral local signing fixtures. The reference suite includes independent protocol, address and arithmetic vectors as well as failure, approval-expiry and ambiguous-finality cases. Builder/checker agreement alone is insufficient assurance. See [REFERENCE](REFERENCE.md) for the supported transaction forms, request bounds, supplied deployment pins and provider trust assumptions.

Both operator types must complete AudaceFi onboarding to obtain their own individual API key before any real connection. API entitlement, account session, wallet signing, server authorization and target qualification are separate requirements. Local examples need no account or key and confer no access.

## Maintainer review requirements

Before distributing a new revision or changing visibility or contribution access:

1. Run the documented controls on the exact proposed revision and obtain independent review from someone who wrote no implementation.
2. Review source, fixtures, outputs, dependencies, license notices, Git history and hosting metadata for the complete proposed disclosure. Keep private audit evidence and operator data outside this repository.
3. Reassess application access, workflow permissions, contributor permissions and the identity policy for GitHub-generated test objects. Existing development connections may process source and events independently of GitHub Actions.
4. Verify attribution and support information. Jordan ([@buchjordan](https://github.com/buchjordan)) is the accountable maintainer. The confidential reporting route for this public repository is GitHub Private Vulnerability Reporting. Verify that the repository setting is enabled and that the reporting form is available. See [SECURITY](../SECURITY.md) for reporting limits.
5. Obtain the owner's explicit approval for the source revision before distributing it. Package publication, deployment and real execution each require separate approval.

Audit conclusions apply only to their exact reviewed source revision, hosting state and stated scope. Private evidence stays outside this repository. Changes to source, access or hosting require reassessment.

## Real integration qualification

Official activation requires a qualified AudaceFi deployment and a release package with its deployment profile, issuer trust information and an active signed approval. AudaceFi supplies the profile and issuer information through a separate release process. The package and issuance channel are pending. Operators independently verify the provenance and currency of the pins they configure, as well as their RPC provider, wallet callbacks and decision policy. An unavailable durable route blocks execution without fallback to cosign, direct RPC or an exchange executor. Preserve write opt-in, journal budgets, unresolved-operation blocking, exact-transaction reconciliation and verified finality.

On a qualified deployment, the account-scoped receipt reports the provisional rank and valuation time from AudaceFi. The kit checks that the response refers to the same intent and transaction and verifies chain finality independently. Evidence from an earlier isolated validation is limited to that run’s recorded revisions and environment.

Any real target test, enrollment, credential provisioning, signing or execution needs a distinct authorized scope and review. See [CONNECTING](CONNECTING.md), [RECOVERY](RECOVERY.md) and [SUPPORT](SUPPORT.md). Apache-2.0 licenses the original source; it does not grant service access or replace third-party obligations.
