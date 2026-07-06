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

**Token delivery via `runtimeConfigSchema` extension** — Inject `daemonToken` alongside `daemonBaseUrl`. Rejected — see the addendum below; the schema stays permanently token-free.

## Addendum (accepted): token delivery and local auth model resolved

This ADR originally deferred the token-delivery question to Stage 4 planning.
That question is now resolved.

### Decision

- `runtimeConfigSchema` remains **permanently token-free**: no `daemonToken`
  field is added. A static Pages build has no per-user injection point at
  build time, so baking a token into a build artifact is not possible; and
  keeping the token out of the runtime-config surface avoids exposing it to
  the logging/error-reporting code paths that already read that config.
- Daemon self-serving and local dev deliver the token through a dedicated,
  separate global — `window.__WHITEBOARD_DAEMON_TOKEN__` — distinct from
  `__WHITEBOARD_RUNTIME_CONFIG__`. The `apps/web` client reads it once at
  startup into an in-memory `TokenStore` (module singleton, never persisted),
  then deletes the global. This is a **serialization-surface reduction, not a
  security boundary** — it does nothing against a script that runs before the
  delete, and is documented as such.
- A static-Pages deployment (Stage 4) uses a pairing flow: a short-lived
  `bootstrapToken` (delivered as a code, or a one-time URL fragment) is
  exchanged for a `sessionToken` that is itself short-lived and memory-only.
- Wire transport is restricted to two channels: the WS subprotocol
  `daemon-token.<token>` and the HTTP `Authorization: Bearer` header. URL
  query parameters, `runtimeConfig`, and build artifacts are all prohibited
  as token carriers.
- Local-daemon read-path carve-out: canvas/asset `GET` endpoints stay
  tokenless, relying on the existing trust model (loopback bind + Host
  loopback check + hard-to-guess IDs). All of `/api/runtime/*` except `ping`
  requires Bearer, including on `GET`. Server-mode requires Bearer on every
  method, with no bypass.
- The `ping` response no longer includes the daemon's OS `pid`; a random
  `instanceId` minted at daemon startup replaces it. `whiteboard server
  stop`'s ownership check switches from pid-matching to instanceId-matching,
  preserving protection against killing an unrelated process that reused the
  port.

### Consequences

- Closes the open question above; no further `runtimeConfigSchema` changes
  are anticipated for the token story.
- As of this addendum the design is accepted but not yet shipped: the
  `/api/*` Host-loopback middleware, the daemon bind-host guard, the
  token-global plumbing on both daemon and `apps/web`, and the ping
  `pid`→`instanceId` swap are tracked as follow-up slices.
- Residual accepted risk: a malicious page on another localhost port can
  still read canvas `GET` responses via reflected CORS; a Stage 4 origin
  allowlist is the planned mitigation.

### Alternatives considered (addendum)

- **Extend `runtimeConfigSchema` with `daemonToken`** — rejected: no per-user
  injection point in a static build, and it would widen the serialization
  surface visible to logging/error-reporting.
- **Tokenize canvas/asset `GET`** — rejected: breaks `<img src>` thumbnail
  usage for negligible defense-in-depth, since a loopback attacker can
  already read the token from local config files.
- **Keep `pid` in `ping` for `server stop` matching** — rejected: publishes
  an OS-level process identifier from an intentionally unauthenticated
  endpoint; a startup-time `instanceId` gives an equivalent ownership check
  without exposing `pid`.
