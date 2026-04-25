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

- **Local-first**: the daemon binds to `127.0.0.1` only and is not exposed externally. The trust boundary is "all processes on the local machine".
- **Daemon token**: HTTP `/api/*` endpoints require a Bearer token issued by the daemon at startup. The token is passed to the browser via injected runtime config.
- **Path validation**: all `sessionId` / `slug` / `fileId` URL parameters are validated against strict regexes to prevent path traversal under `~/.whiteboard/`.
- **Body limits**: WebSocket frames are capped at 8 MiB, file uploads at 16 MiB, and `/mcp` JSON-RPC requests at 4 MiB to mitigate DoS.
- **External fetches**: `library_install` and friends fetch user-provided HTTPS URLs but block private IPs / loopback / link-local addresses (SSRF guard).

## What is **not** in scope

- Multi-tenant or remote MCP deployments are not supported. Running this server on a public host is out-of-scope.
- The browser canvas runs in the same trust domain as the daemon. Malicious browser extensions or local processes can read/write canvas state directly.
- The npm package is unsigned (no `npm provenance` yet — tracked as a roadmap item).
