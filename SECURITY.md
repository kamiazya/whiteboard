# Security Policy

## Supported Versions

`@kamiazya/whiteboard-mcp` is in pre-1.0 development. Only the latest published version on npm is actively patched.

| Version | Status |
| --- | --- |
| latest `0.x.y` | ✅ supported |
| older `0.x.y` | ❌ not maintained — please upgrade |

## Reporting a Vulnerability

If you find a security issue (RCE, path traversal, SSRF, sandbox escape, secret exposure, etc.), please **do not open a public GitHub issue**.

Instead, use GitHub's **private vulnerability reporting** at https://github.com/kamiazya/whiteboard/security/advisories/new. The report is visible only to you and the project's maintainers (listed in [`.github/CODEOWNERS`](.github/CODEOWNERS)).

Please include:

- A clear description of the issue and its impact
- Reproduction steps (commands, sample inputs, expected vs actual behavior)
- Affected version(s)
- Any suggested mitigation

We aim to acknowledge within 72 hours and to ship a patch (or coordinated disclosure plan) within 14 days for high-severity issues.

## Coordinated disclosure

- A confirmed vulnerability is fixed in private on the advisory's temporary fork, released, and then disclosed as a [GitHub Security Advisory](https://github.com/kamiazya/whiteboard/security/advisories) for this repository, with a CVE requested through GitHub when the issue affects a published release.
- The advisory names the affected and fixed versions, and the release notes of the fixing release ([CHANGELOG.md](CHANGELOG.md), [packages/mcp-server/CHANGELOG.md](packages/mcp-server/CHANGELOG.md)) link it.
- We ask reporters to keep the issue private until the advisory is published, or for 90 days from the report, whichever comes first.

## Remediation thresholds for dependency and static-analysis findings

These are what the automated gates enforce, not a statement of intent:

- **Known-vulnerable dependencies (SCA).** An advisory of **high** or **critical** severity in a runtime dependency fails the merge — `pnpm audit:prod` in CI over the whole tree, and the Dependency Review check over what a pull request adds — and fails the release: `release.yml` audits the lockfile and the packed tarball before publishing. The same audit runs daily against an unchanged tree (`.github/workflows/audit.yml`), so an advisory published after a merge is still seen. A finding below that threshold is fixed through the regular Dependabot update flow.
- **Static analysis (SAST).** CodeQL is a required check on the default branch, so a new alert at its failing severity blocks the merge. An alert dismissed as a false positive or as not exploitable is dismissed in code scanning with its reason, where it stays on the record.

## Verifying a release

- **npm package.** `npm audit signatures` in a project that installed `@kamiazya/whiteboard-mcp` verifies the registry signature and the provenance attestation of every installed package. The provenance names the GitHub Actions workflow (`release.yml`), commit and ref that built the tarball; `npm view @kamiazya/whiteboard-mcp@<version> dist.attestations` shows where it is published.
- **Container image.** The cosign verification commands, with the exact certificate identity to pin, are in [docs/contributing/releasing.md](docs/contributing/releasing.md).

## Security Model

[docs/explanation/security-model.md](docs/explanation/security-model.md) is the single description of what Whiteboard trusts and protects against, for each runtime it ships: the browser, the local daemon (an owner-only local socket, reached by a hosted page only through the browser extension), and server mode (a shared server behind your own identity provider and TLS). It is kept in step with the code; read it rather than a summary here.

## What is in scope

A report is in scope when it affects the latest published `@kamiazya/whiteboard-mcp`, the container image, or the hosted web app, in any of the three runtimes above, including self-hosted server mode ([Self-host with Docker](docs/how-to/self-host-with-docker.md)).

## What is **not** in scope

The security model page's "Current limitations" section lists what the project does not claim. In particular:

- A program running as the same operating-system user as the daemon is inside its trust boundary: it can open the socket and read the daemon's credential file exactly as the CLI does.
- Server mode is usable with a competent operator, not zero-configuration safe: the identity provider, TLS and network exposure are the operator's to configure.
- Reports that depend on a compromised browser, a malicious browser extension, or physical access to the machine.

## Release provenance

Releases are published from GitHub Actions with no stored registry credential:

- The npm package is published with npm provenance (`npm publish --provenance`, OIDC trusted publishing), and each release run uploads a CycloneDX SBOM as a workflow artifact.
- The container image is pushed with Docker provenance and SBOM attestations and is signed with cosign keyless signing (Sigstore OIDC). The verification command is in [docs/contributing/releasing.md](docs/contributing/releasing.md).
