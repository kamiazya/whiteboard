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

## Addendum (accepted): the mixed-content premise was wrong — hosted HTTPS → loopback HTTP works via Local Network Access

This ADR's Context section stated that "a page served over `https://` cannot
make `http://` requests — this is enforced before CORS and cannot be
overridden by CSP", and derived from it a hard fork: hosted-Pages pairing
would require an HTTPS daemon (mkcert, Approach B). Empirical verification
against the real production origin disproved that premise for two of the
three engine families.

### Measured facts (2026-07-08, real `https://kamiazya-whiteboard.pages.dev` page)

A CORS-permissive probe server on `http://127.0.0.1` was fetched from page
context in each engine, driven by Playwright on macOS (page URL:
`https://kamiazya-whiteboard.pages.dev/`, app build v0.0.10). These are
observations from the listed builds, not guarantees for whole engine
families; re-run the harness below before relying on them for a new
browser version.

| Engine (tested build) | Result | Mechanism |
|---|---|---|
| Chromium 149 (Playwright bundled) | **Succeeds (200)** once the `local-network-access` permission is granted; hangs on the pending permission prompt until the user decides | [Local Network Access](https://developer.chrome.com/blog/local-network-access) (permission prompt shipped in Chrome 142) includes a mixed-content exemption for local/loopback targets. Requestable only from secure contexts — the hosted HTTPS page is the intended client. |
| Firefox 148.0.2 (Playwright build v1511) | **Succeeds (200)** with no prompt | Loopback is a potentially-trustworthy origin; the fetch is not treated as mixed content. Plain CORS governs. |
| WebKit (Playwright build 2272, macOS) | **Blocked** (`requested insecure content … blocked`) | The tested WebKit build applies no loopback mixed-content exemption. The original premise held only in this engine as tested. |

The remaining blocker for hosted pairing is therefore **this repo's own
daemon policy**, not the browser: with a `pages.dev` Origin the daemon
returns no `Access-Control-Allow-Origin` on `/api/*`, 403 on `/mcp`, and
rejects the WS upgrade (loopback-hostname Origin gate) — all verified
against a running daemon.

### Re-measured (2026-07-12): WebSocket is still not LNA-gated

The remaining unknown from the addendum above — whether Chromium's LNA
gating had been extended to the WebSocket upgrade — has been re-measured
with a committed, reusable harness
(`packages/mcp-server/scripts/smoke/mcp-lna-transport-smoke.mjs`, run via
`pnpm --filter @kamiazya/whiteboard-mcp smoke:lna-transport`). It drives all three engines against the same
real `https://kamiazya-whiteboard.pages.dev` origin, this time probing both
a `fetch` (baseline re-confirmation) and a `new WebSocket(...)` upgrade to a
throwaway, fully CORS-permissive loopback probe server — not this repo's own
daemon, so the daemon's own origin gate (F4 above) cannot mask browser-level
behavior.

| Engine (tested build) | `fetch` (no LNA grant) | `fetch` (LNA granted) | WS upgrade (no LNA grant) | WS upgrade (LNA granted) |
|---|---|---|---|---|
| Chromium 147.0.7727.15 (Playwright bundled) | Fails fast (`TypeError: Failed to fetch`, ~25ms; `permissions.query` reports `prompt`) | Succeeds | **Succeeds** | Succeeds |
| Firefox 148.0.2 (Playwright build v1511) | Succeeds (no permission concept applies) | n/a | Succeeds | n/a |
| WebKit (Playwright build 2272, macOS 26.4) | Blocked (`TypeError: Load failed`) | n/a | Blocked | n/a |

Two findings, both load-bearing for ADR-0005's connection-ticket design:

1. **The WebSocket upgrade is *not* gated behind Local Network Access on
   this Chromium build, even with no permission granted at all.** A page
   with an undecided (`prompt`) LNA permission state can still open a raw
   loopback WebSocket while its `fetch` to the same loopback origin is
   blocked outright. This means the earlier open question — "does a grant
   covering the ticket `fetch` also cover the socket open, or is a separate
   grant required?" — does not yet arise in practice: **no grant is
   required for the socket at all**, only for the `fetch` that mints the
   ticket. This is a **currently-observed gap** (Chromium's LNA WebSocket
   gating is still tracked upstream, not yet shipped), not a guaranteed
   permanent exemption — the connection-ticket flow must not depend on it
   staying this way, and should still surface a denied/blocked LNA grant on
   the ticket `fetch` as an explicit error per ADR-0005, rather than assume
   the socket will silently succeed forever.
2. **The undecided-permission `fetch` failure is fast, not a hang, in this
   automated build** (~25ms, not the addendum's previously observed 5-second
   silent timeout). Automation does not surface the real permission-prompt
   UI, so this is consistent with — not a contradiction of — the addendum's
   standing caveat that "the real user-facing prompt UX" remains unverified
   by this harness; a fast rejection here plausibly corresponds to an
   automated context resolving the prompt as denied rather than leaving it
   pending, which a real interactive user would instead see as a visible
   permission prompt. This nuance should be re-checked with manual/real
   browser verification before the connection-ticket UX is finalized.

Re-run `pnpm --filter @kamiazya/whiteboard-mcp smoke:lna-transport` whenever
a browser build moves, to catch the day Chromium's WS gating ships.

### Decision (supersedes the Approach A/B framing above)

- **Approach B (mkcert) is demoted** from "the only viable path for hosted
  pairing" to a WebKit/Safari-compatibility option. It is not required for
  hosted pairing on Chromium- or Gecko-based browsers.
- **Hosted pairing targets LNA**: the hosted page requests the
  `local-network-access` permission (Chromium) or relies on the loopback
  trustworthiness carve-out (Firefox); the daemon must then admit the exact
  hosted origin — an exact-match origin allowlist on `/api/*` CORS, `/mcp`,
  and the WS upgrade is the prerequisite work, never a wildcard or suffix
  match.
- **Browser support is capability-tiered, detected by probe, not UA
  sniffing**: Tier 1 (browser-local + daemon pairing) — Chromium ≥ 142 and
  Firefox; Tier 2 (browser-local only) — WebKit/Safari, which must see an
  explicit "daemon pairing not supported in this browser" state instead of a
  silent failure. The existing capability-gating architecture (ADR-0004)
  carries this without a new mechanism.
- **The `mixed-content-skipped` pre-flight guard above is superseded.** The
  availability-detection spec earlier in this ADR required the probe to
  return `{ reachable: false, reason: 'mixed-content-skipped' }` without
  fetching whenever `location.protocol === 'https:'` and `daemonBaseUrl`
  starts with `http:`. Under that guard the LNA flow would never start.
  Replacement behavior: on an HTTPS page with a loopback HTTP
  `daemonBaseUrl`, the probe MUST attempt the fetch (triggering the
  permission prompt on Chromium where applicable) and classify the observed
  outcome afterward. `mixed-content-skipped` remains only as the classified
  outcome for engines that actually block the request (the tested WebKit
  behavior), no longer as a pre-flight short-circuit.
- **The probe result classification must be extended** beyond
  `timeout | network-error | mixed-content-skipped | not-daemon | auth-error`
  to distinguish the LNA-era outcomes: at minimum a pending/denied
  permission state (Chromium exposes `navigator.permissions.query({ name:
  'local-network-access' })` to disambiguate a prompt-pending hang from a
  plain timeout) and an engine-blocked state. The exact enum is an
  implementation concern of the availability-probe slice; this ADR only
  fixes the requirement that these outcomes are distinguishable and drive
  the capability tiers below.
- The local-dev HTTP pairing scope shipped under Approach A remains valid
  and unchanged; LNA extends the same server surface to hosted origins
  rather than replacing it.

### Consequences

- The daemon-side exact-match origin allowlist graduates from "residual-risk
  mitigation, optional" to the gating prerequisite for any hosted pairing.
- A reproducible cross-engine harness exists: drive the production page with
  Playwright, grant `local-network-access` via `grantPermissions`, and probe
  loopback — usable as a regression check for the transport assumptions in
  this ADR.
- Unverified remainder, to re-check before shipping hosted pairing: the real
  user-facing prompt UX (automation bypasses the prompt), and LNA rollout
  changes (origin trial / enterprise policy knobs). WS behavior has been
  re-measured (2026-07-12, below): still not LNA-gated on the tested
  Chromium build, but re-run the harness when Chromium ships WS gating.

## Addendum (accepted): the canvas/asset GET carve-out is retired

The first addendum above left canvas/asset `GET` tokenless in local-daemon
mode, accepting the residual risk that "a malicious page on another
localhost port can still read canvas `GET` responses via reflected CORS."
ADR-0005 names a Stage 4 origin allowlist as the mitigation for that risk,
then goes further: once a *hosted* origin is an admitted CORS caller, the
same tokenless surface lets that origin — or anyone who gets past the
allowlist — read every canvas with no credential at all, making
`canvas:read` theatre on the read path. ADR-0005 marked this "a prerequisite
slice" rather than deciding it; this addendum is that decision.

### Why the original reasoning no longer holds

The carve-out rested on two premises, and both are gone:

1. **"Tokenizing reads breaks `<img src>` thumbnails."** This was the stated
   cost that justified leaving `GET` open. The consumer audit below found
   the cost never actually existed in the shipped app: every real
   thumbnail/file consumer already fetches the bytes through the
   bearer-carrying transport and renders an `object URL`, so there was
   nothing left to trade away. A carve-out justified by a cost that isn't
   there is not a considered trade anymore — it is just an open door.
2. **"Loopback bind + Host-loopback check contain the blast radius."** That
   containment assumption is exactly what a hosted origin as a first-class
   client (ADR-0005) removes: the daemon is now meant to accept requests
   from an origin that is not loopback at all, admitted deliberately
   through the CORS allowlist. Once that is the design, "only a page
   running on localhost can reach this" stops being true by construction,
   and the carve-out's whole safety argument goes with it.

Cookie-based auth was also considered and rejected as an alternative to a
bearer header: cookies are sent automatically by the browser on every
matching-origin request, which is exactly the CSRF surface a bearer token
in an explicit `Authorization` header does not have. ADR-0002's original
decision already restricts token carriers to the `Authorization` header and
the WS subprotocol; nothing here reopens that restriction.

### The consumer audit

Every place `apps/web` reads daemon-served canvas/asset bytes was audited
for whether it goes through the bearer-carrying client or bypasses it with
a bare `<img src>` / URL construction:

- `shared/api-client.ts`'s `apiFetch` already attaches `Authorization:
  Bearer <token>` to every same-origin `/api/*` request, GET included.
- `VersionThumbnail.tsx` and `CanvasThumb.tsx` (the only two thumbnail
  surfaces; every other consumer — `VersionTimeline`, `MergeDialog`,
  `WorkspaceTopBar`, `DaemonIndexPage` — renders through one of these two)
  already fetch the thumbnail bytes through the daemon-aware fetch and
  render an object URL, falling back to a bare `<img src>` only when no
  `DaemonApiContext.Provider` is mounted.
- `shared/daemon-backend.ts`'s `getFile` (pasted/embedded canvas assets)
  already fetches through the same transport, never `<img src>`.
- Auditing where `DaemonApiContext.Provider` is mounted found it wraps
  *every* real daemon-connected page (`DaemonCanvasPage`, `DaemonIndexPage`)
  unconditionally — the "no provider" fallback branch in
  `VersionThumbnail`/`CanvasThumb` has no reachable production caller today.
  It is dormant defensive code, not a live tokenless path; it would need
  reintroducing a same-origin, provider-less render path (e.g. a future
  daemon-self-served UI distinct from apps/web) before it mattered again.

### Decision

The measured client-side cost of tokenizing every canvas/asset read is
**zero** — it already shipped. So the carve-out is retired outright, not
narrowed to "cross-origin callers only": local-daemon mode now requires the
shared bearer token on every `/api/*` request, read or write, with the sole
exception of `/api/runtime/ping` (the pre-authentication availability
probe). See `requiresDaemonAuth` in `packages/mcp-server/src/server/routes/auth.ts`.

This retires the second bullet under "Local-daemon read-path carve-out" in
the first addendum above: canvas/asset `GET` is no longer tokenless.
`/api/runtime/*` behavior (all but `ping` requires Bearer) is unchanged.

### Consequences

- `canvas:read` now means something on every code path, not just the
  server-mode OAuth path.
- An unauthenticated `GET` to any `/api/*` route other than
  `/api/runtime/ping` now 401s instead of 404ing on an unmatched path —
  auth runs ahead of routing, so route existence is not distinguishable
  without a bearer either way.
- If a future same-origin, provider-less render path is reintroduced (the
  dormant `<img src>` fallback in `VersionThumbnail`/`CanvasThumb` becoming
  reachable), it will 401 rather than silently degrade, because the server
  no longer has a tokenless GET surface to fall back on. That is the
  intended failure mode — a broken image is loud; a silent unauthenticated
  read is not.

### Alternatives considered (this addendum)

- **Signed/query-token URLs for thumbnails** — rejected without needing to
  argue past the query-parameter ban above: the fetch+blob path was already
  shipped and free, so there was no cost left to justify reopening that
  ADR-0002 prohibition for.
- **Cookie-based auth instead of a bearer header** — rejected: a cookie is
  attached by the browser automatically on any matching-origin request,
  which is a CSRF surface a bearer token carried in an explicit
  `Authorization` header structurally does not have. This does not change
  the original decision to restrict token carriers to the `Authorization`
  header and the WS subprotocol; it only reconfirms it for the read path.
- **Narrow the carve-out to cross-origin callers only, keep same-origin GET
  open** — rejected as a half-measure: it would leave the matrix claiming
  protection the code does not uniformly provide, and the same-origin case
  has no weaker threat model once a hosted origin can be same-origin-
  equivalent via LNA (ADR-0002's second addendum).
