# Repository rules

During private preparation, keep this repository PRIVATE until an explicit owner opening decision. No merge, public release, package publication, deployment, real account, wallet operation, signature, RPC, model inference or trade is authorized by development or a passing test.

This repository contains connection code for both AI agents and trading bots; preparing or distributing that code does not authorize real execution. The client and operator interfaces may contain explicitly callable HTTP operations; import, construction, demos and tests must not call a real service. Test with injected synthetic transports and ephemeral local signing fixtures only. The offline CLI remains closed and network-denied.

Do not read .env or user configuration, copy private product source/data/logs/credentials/history, or access unrelated private repositories or applications. Source references may be inspected read only under their own rules. Account, session, API-key, wallet-signature and server-cosign authorities remain separate. Never add a fallback from an unavailable durable route to cosign, RPC or an exchange executor.

A separate reviewer who wrote no implementation must review code and CI. Reassess source, dependencies, examples, outputs, history, access and hosting before opening. Record private audit evidence outside this repository. Any real target test, provider interaction, credential provisioning, publication or execution requires a separate explicit scope and review.

The concrete reference adapter is limited to the documented devnet bench profile. Preserve separately qualified pins, API deployment approval expiry, read-only RPC methods, full plan rechecks across wallet/credential waits and unknown finality for unsupported evidence. Shared builder/checker ABI agreement is insufficient assurance: retain independent protocol/PDA/math vectors and review. Do not embed actual deployment profiles or real credentials as examples. See docs/REFERENCE.md for provider trust, supported forms and request bounds.
