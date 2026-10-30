# Contributing

Changes to repository visibility and contributor access require an explicit maintainer decision. Accepted changes may cover the typed connection client, shared agent/bot flows, protocol validation, local recovery, documentation and synthetic fixtures. Real target activity, a new provider/signer/RPC integration, deployment or execution still requires a separate scope and qualification.

Use the contribution workflow enabled by the maintainer for this repository. Supply affected revision, pinned tool versions, synthetic reproduction and expected/observed results. Use the private route in [SECURITY](SECURITY.md) for vulnerabilities; do not publish account data, credentials, signed transaction bytes, operator journals or internal audit material.

Keep dependencies locked and justify additions. Run `npm run check` with the documented runtime and request review by someone who wrote no implementation. Preserve the network-denied offline CLI and tests, explicit client write opt-in, bounded transport, journal-before-write ordering and ambiguity handling. Do not turn a failure into a retry, confirmation or a new transaction. A model reply is data, never a module, URL, key or transaction to execute.

Changes affecting contributors, permissions, automation or source visibility require a fresh access review. Establish the GitHub-generated test-object identity policy before creating a new PR; no PR, workflow or publication is implied by this document.

Original contributions intentionally submitted for inclusion use Apache-2.0 as described in [LICENSE](LICENSE). Submit only material you have the right to license and preserve third-party terms and notices. Do not copy private product implementation or data into the starter. This contribution scope adds no downstream license restriction and grants no service or account access.
