# ADR-0002: Browser-to-daemon transport for Stage 4

**Status:** Accepted

## Context

Stage 4 of the `apps/web` canonical frontend migration (see ADR-0001) requires `apps/web` to connect to a locally running daemon. This introduces a transport problem: a browser page fetching a local HTTP endpoint faces browser security restrictions that do not apply to a native app.

The key constraint is **mixed-content**: a page served over `https://` cannot make `http://` requests — this is enforced before CORS and cannot be overridden by CSP. This creates a hard fork between a local-dev HTTP scenario and a hosted-page scenario.

Additional constraints confirmed by codebase inspection:

- `/api/*` routes have zero CORS headers today (`auth.ts` covers mutation-only paths).
- Private Network Access (PNA) preflight (`Access-Control-Allow-Private-Network`) is absent from both `/api/*` and `/mcp` middleware.
- The daemon does not perform TLS termination.
- `apps/web/src/runtime-config.ts` uses `.strict()` parse; injecting unknown keys throws `invalid-config`.

## Decision

**Approach A for Stage 4: local-dev HTTP pairing** (`http://localhost:5173` ↔ `http://127.0.0.1:3099`, same scheme). This is the primary developer use case and is feasible with the following server additions, all shipped in one increment:

1. **CORS middleware for `/api/*` in local-daemon mode** — parse `Origin` hostname, check `isLoopbackHostname`, reflect `Access-Control-Allow-Origin: <origin>` + `Vary: Origin`. Applied before `createDaemonMutationAuthMiddleware`, guarded by `authMode !== 'server-mode'`.
2. **`Access-Control-Allow-Private-Network: true` on OPTIONS** — added to both the new `/api/*` middleware and the existing `mcp-http.ts` middleware (currently absent).
3. **`daemonBaseUrl` config injection** — when the daemon serves the `apps/web` build, inject `daemonBaseUrl: http://127.0.0.1:${port}` into `window.__WHITEBOARD_RUNTIME_CONFIG__`. The `runtimeConfigSchema` already accepts this field; no schema change required.

Availability detection in `apps/web`:

- New module `apps/web/src/lib/daemon-probe.ts` with Zod schemas (`daemonPingResponseSchema`, `daemonProbeResultSchema`); types via `z.infer<>`, never a parallel hand-written interface.
- Probe: `GET {daemonBaseUrl}/api/runtime/ping` (unauthenticated, 2s timeout via `AbortController`).
- Mixed-content pre-flight guard: if `location.protocol === 'https:' && daemonBaseUrl.startsWith('http:')` → return `{ reachable: false, reason: 'mixed-content-skipped' }` without fetching.
- `401`/`403` → `auth-error` → non-dismissable error banner; must NOT silently fall back to browser-local (silent fallback misleads users into believing they are daemon-synced).

**Approach B (mkcert-HTTPS daemon) is a named follow-on slice**, gated on the open question of whether hosted Cloudflare Pages ↔ local daemon pairing is a Stage 4 requirement. It is not implemented in this stage.

**Portless (`*.localhost`)** is deferred and security-gated (not in scope for Stage 4).

## Consequences

- Local developers running `http://localhost:5173` + `pnpm mcp:http:dev` get real daemon-backed workspaces instead of a static placeholder.
- The hosted Cloudflare Pages app (`https://*.pages.dev`) cannot connect to a local HTTP daemon — mixed-content blocks it. That use case requires Approach B (mkcert) or an alternative delivery mechanism, decided separately.
- `auth-error` must surface as a visible, non-dismissable banner to prevent silent data loss.
- A `fetch(.../api/runtime/ping)` + `daemonPingResponseSchema.parse()` step must be added to `scripts/smoke/mcp-e2e-smoke.mjs` as a runtime drift guard.

## Alternatives considered

**Approach B (mkcert-HTTPS) for Stage 4** — Enables hosted page ↔ local daemon. Rejected for Stage 4: requires TLS termination in the daemon (absent), a manual `mkcert -install` step, and CSP changes. Too wide a scope; named as a follow-on.

**Portless (`whiteboard.localhost`)** — Would avoid mixed-content for the hosted case. Rejected: `whiteboard.localhost` is not in `isLoopbackHostname`, so the daemon returns 403; deferred pending security review.

**Token delivery via `runtimeConfigSchema` extension** — Inject `daemonToken` alongside `daemonBaseUrl`. Deferred: `runtimeConfigSchema.strict()` would reject an unknown `daemonToken` field, throwing `invalid-config`. The schema must be extended first via `z.infer<>` (no parallel interface). This open question is resolved at Stage 4 planning.
