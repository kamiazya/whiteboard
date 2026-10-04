# Security Policy

## Supported Versions

`@kamiazya/whiteboard-mcp` is in pre-1.0 development. Only the latest published version on npm is actively patched.

| Version | Status |
| --- | --- |
| latest `0.x.y` | ✅ supported |
| older `0.x.y` | ❌ not maintained — please upgrade |

## Reporting a Vulnerability

If you find a security issue (RCE, path traversal, SSRF, sandbox escape, secret exposure, etc.), please **do not open a public GitHub issue**.

Instead:

1. Use GitHub's **private vulnerability reporting** at https://github.com/kamiazya/whiteboard/security/advisories/new
2. Or email the maintainer directly at the address listed in the npm package metadata

Please include:

- A clear description of the issue and its impact
- Reproduction steps (commands, sample inputs, expected vs actual behavior)
- Affected version(s)
- Any suggested mitigation

We aim to acknowledge within 72 hours and to ship a patch (or coordinated disclosure plan) within 14 days for high-severity issues.

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
