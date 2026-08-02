# Security Model

Whiteboard runs in one of three runtimes, each with its own trust model:
**browser-local** (canvas data never leaves the browser's IndexedDB),
**local daemon** (loopback-only server for MCP/agent work, covered below),
and **server mode** (a shared server behind your own Identity Provider and
TLS, covered in its own section and in
[Self-host with Docker](../how-to/self-host-with-docker.md)). Do not read
one runtime's trust model as describing another — local-daemon tokens and
server-mode JWTs are separate credential systems and must never be mixed.

This page describes the **local daemon** in detail first, then server mode.

## Local daemon: trust boundary

- The daemon binds to `127.0.0.1` (not `localhost`) by default, restricting access to the loopback interface.
- HTTP routes under `/api/*` apply auth in two layers. First, a global middleware protects all mutation methods (`POST`, `PUT`, `PATCH`, `DELETE`) under `/api/*` except `/api/runtime/*`, which has its own per-router middleware. Second, `/api/runtime/*` routes — including read-only endpoints such as `GET /api/runtime/status` and `GET /api/runtime/storage` — require a Bearer token for every request except `/api/runtime/ping`, which is an unauthenticated liveness probe. Canvas and workspace `GET` routes outside `/api/runtime/` are unauthenticated in local-daemon mode and serve canvas metadata to the local browser without requiring credentials.
- The `/mcp` HTTP transport applies token checks and restricts the `Origin` header to loopback addresses (`127.0.0.1`, `::1`, or `localhost`).
- The packaged `stdio` MCP path does not use OAuth. Trust comes from the local process that launches the server.

## Loopback origin squatting (browser-local storage)

A browser origin is defined by scheme + host + port, not by which process
currently answers on that port. On `http://localhost:<port>` (Vite's dev
port 5173 in particular is among the most commonly contended ports on a
developer machine), whatever process later binds that port inherits the
full origin — including everything IndexedDB and localStorage hold for it,
with no additional prompt or permission check. This is ordinary browser
origin semantics, not a Whiteboard-specific bug, and it is not something
this project can fix by itself.

The practical consequence: **pairing with a local daemon now requires a
fresh `#wb=` link every session.** An earlier "silent reconnect" feature
stored a possession credential (a WebCrypto keypair, with a plaintext
localStorage secret as a fallback for older daemons) in this origin's own
browser storage specifically so a reload would not require re-pairing. That
credential is exactly what a port-squatting process could read or invoke —
a non-extractable `CryptoKey` does not need to be exfiltrated to be abused;
same-origin script can call `crypto.subtle.sign()` with it directly, and a
plaintext secret needs no cryptography at all. The feature has been
**removed entirely** rather than hardened, because eliminating the
credential is the only fix that does not depend on trusting the origin —
see [Connect to a local daemon → Pairing is required every
session](../how-to/connect-to-local-daemon.md#pairing-is-required-every-session)
for what this means day-to-day.

**This does not extend to canvas data itself.** Browser-local mode's
canvases, files, and CRDT history in IndexedDB remain readable by whatever
later owns the origin — the same squatting scenario applies to your actual
canvas content, not only to daemon credentials, and there is no equivalent
fix available: the data has to live somewhere addressable by that origin
for the browser-local runtime to work at all. Treat a shared or
frequently-reused development port accordingly, and prefer the local
daemon (loopback-bound, its own token) over browser-local storage for
anything you would not want a future occupant of that port to read.

## HTTP protections

- **Bearer token**: local HTTP clients must send `Authorization: Bearer <token>` when token auth is enabled. The token is written to `daemon.json` in the data directory (`~/.whiteboard` by default) so the stdio MCP server can locate the running daemon. The file is created with mode `0o600` (owner-read/write only) and is re-chmod'd after write on non-Windows platforms to counteract a permissive umask. Treat `daemon.json` as a credential file and ensure the data directory itself is not world-readable.
- **Origin checks**: `/mcp` only allows loopback browser origins (`127.0.0.1`, `::1`, or `localhost`) for local HTTP use. All three resolve to the same loopback interface; allowing `localhost` is consistent with browser behavior across platforms.
- **Hosted web-app pairing**: a browser app served from a non-loopback (hosted `https:`) origin can still pair with the local daemon, but only once that origin is listed in `WHITEBOARD_ALLOWED_WEB_ORIGINS` — a comma-separated, HTTPS-only allowlist whose entries are exact origins or `https://*.example.com` leftmost-label wildcard subdomain patterns (bare `*` is never permitted; see [Configuration → Wildcard subdomain patterns](../reference/configuration.md#wildcard-subdomain-patterns)). Loopback origins need no allowlist entry. This env var governs the local daemon only; it is unrelated to server mode's origin allowlist below.
- **Security headers**: the app serves `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, and same-origin cross-origin headers.
- **Debug route gate**: `/api/debug` is hidden unless `WHITEBOARD_DEBUG=1` is set, and still requires Bearer auth when a token exists.

## File-system safety

- Runtime data is stored under `~/.whiteboard` by default.
- Canvas identifiers are validated before they are mapped to file paths.
- Export and upload flows stay within daemon-controlled storage paths unless explicitly extended.

## Browser-dependent operations

Some operations require a connected browser client.

- `viewport_set`

This action is routed through the daemon to the browser and fails fast when no browser client is connected. `export_canvas` (all formats, including `png`) is rendered headlessly from the persisted document and does not require a connected browser client.

## WebMCP (experimental, browser-only, read-only)

`apps/web` optionally registers a small set of read-only tools with the
browser's own in-page [WebMCP](https://developer.chrome.com/docs/ai/webmcp)
API (`document.modelContext`), currently shipping in flag-gated Chrome
builds. This is unrelated to the daemon's `/mcp` endpoint above — WebMCP
tools live entirely inside the tab and are only reachable by whatever agent
that specific browser tab is exposing them to, not by the daemon or any
network peer.

What is shipped today (Phase 0):

- **Feature-detected, zero-impact elsewhere.** In any browser without
  `document.modelContext` the integration is a complete no-op — no
  listeners, no registration attempts, no UI change.
- **One read-only tool**, registered only when all three hold: a canvas is
  open, the user's persisted `webMcpEnabled` capability is on, and
  `document.modelContext` exists. Turning the capability off unregisters the
  tool exactly as an absent `document.modelContext` would.
  - `whiteboard_get_app_context` — which provider mode (`daemon` or
    `browser-local`) and which canvas identity is open. Never includes
    `daemonBaseUrl`, tokens, or any other connection detail.
- **No write tools.** Nothing registered today can mutate a canvas.
- The tool's result shape is pinned by an automated JSON Schema
  agreement test, and the whole tool list by an automated manifest
  snapshot test, so a future change to either surfaces as a reviewable
  diff.

What is intentionally *not* shipped yet: write/mutation tools, full-scene
content in any tool result, and any non-Chrome browser support. Treat this
as an early, experimental surface — the underlying WebMCP specification is
still a CG Draft and its API shape (currently `document.modelContext`, not
`navigator.modelContext`) may change before it stabilizes.

## Server mode: trust boundary

Server mode (`whiteboard server run`, packaged as `Dockerfile.server` — see
[Self-host with Docker](../how-to/self-host-with-docker.md)) is a separate,
shipped deployment path for running whiteboard as a shared server beyond
loopback. It uses its own credential system — **never mix local-daemon
Bearer tokens with server-mode JWTs; they are not interchangeable.**

- Every request is authenticated with a JWT issued by an external Identity
  Provider (OAuth/JWT resource-server validation); the server itself does
  not issue or manage user credentials.
- Cross-origin access is restricted by `WHITEBOARD_SERVER_ALLOWED_ORIGINS`,
  an explicit `https://` allowlist (defaulting to
  `WHITEBOARD_SERVER_EXTERNAL_URL` when unset). Entries may be exact origins
  or a `https://*.example.com` leftmost-label wildcard subdomain pattern for
  deployment-preview shapes (e.g. Cloudflare Pages branch previews); bare `*`
  is always rejected. See
  [Configuration → Wildcard subdomain patterns](../reference/configuration.md#wildcard-subdomain-patterns)
  for the exact matching rules and the residual `*.pages.dev`-style breadth
  risk. This is a distinct setting from the local daemon's
  `WHITEBOARD_ALLOWED_WEB_ORIGINS` above; the two are read by different
  code paths and never consult each other.
- The container binds plain HTTP to **all interfaces (`0.0.0.0`) by
  default** (`WHITEBOARD_SERVER_HOST` overrides this); **TLS termination is
  the operator's responsibility**, done by a reverse proxy in front of the
  container (nginx, Caddy, Traefik, …). Mapping the port straight to a
  public interface exposes plain HTTP — server mode is not safe to expose
  directly to the internet without that proxy in place.
- Server mode is only as secure as its operator's configuration: a
  correctly configured Identity Provider, a correctly scoped origin
  allowlist, and TLS termination are all prerequisites the operator must
  provide — server mode does not ship "safe out of the box" without them.
- JWTs must self-identify as **access tokens**, not ID tokens: the server
  requires either the RFC 9068 `typ: at+jwt` header or a `token_use: access`
  payload claim (the AWS Cognito convention) before accepting the token.
  This stops a leaked/stolen ID token from an IdP that reuses the same
  audience for both token kinds from being replayed as an access token. If
  your IdP's access tokens omit both discriminators, set
  `WHITEBOARD_SERVER_JWT_ALLOW_UNTYPED_ACCESS_TOKENS=true` to opt out —
  only do this when you have confirmed the IdP truly never issues typed
  access tokens.

## Current limitations

- Server mode is shipped and used today for team/remote deployments (see
  above); it is not itself production-hardened beyond what is documented on
  this page — treat it as "usable with a competent operator," not
  "zero-configuration safe."
- Storage quotas, telemetry policy, and remote threat-model docs are still
  separate follow-up items: this page describes trust boundaries and
  protections as implemented, not a vetted threat model for adversarial
  remote environments.
