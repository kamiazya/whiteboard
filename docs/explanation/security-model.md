# Security Model

Whiteboard runs in one of three runtimes, each with its own trust model:
**browser** (canvas data never leaves the browser's IndexedDB),
**local daemon** (a per-user server on an owner-only local socket, for MCP/agent work, covered below),
and **server mode** (a shared server behind your own Identity Provider and
TLS, covered in its own section and in
[Self-host with Docker](../how-to/self-host-with-docker.md)). Do not read
one runtime's trust model as describing another — local-daemon tokens and
server-mode JWTs are separate credential systems and must never be mixed.

This page describes the **local daemon** in detail first, then server mode.

## Local daemon: trust boundary

The local daemon has one person: the machine's owner
([ADR-0050](../contributing/adr/0050-local-daemon-trust.md)).

- **It listens on no network port.** On Linux and macOS it listens on a Unix
  socket in the per-user runtime directory (`$XDG_RUNTIME_DIR/whiteboard/`,
  or a `whiteboard-<uid>` directory in the temp directory). The directory is
  refused unless it is owned by this user and owner-only (`0700`), and the
  socket itself is `0600`. On Windows it listens on a named pipe whose name
  is random per start, so another user cannot predict it and create it
  first. Only the daemon's record, `daemon.json` (owner-only), says where.
- **Every client reaches it there**: the CLI, the stdio MCP entry, and the
  native messaging host that the browser extension starts. A web page never
  talks to the daemon over HTTP, and the daemon serves no page — there is no
  consent page, no pairing, no browser `Origin` to judge and no CORS.
- **The daemon's bearer token is the credential.** `/api/*` and `/mcp`
  require it when one is configured (as `whiteboard daemon run` always
  does). The native host reads it from `daemon.json` and attaches it
  itself, so the page never holds it. A narrower credential the operator
  mints (a macaroon) is judged against the route-scope registry.
  `/api/runtime/ping` and `/api/runtime/verify` are public; there is no HTTP
  route that stops the daemon.
- **The browser starts the native host only for the whiteboard extension.**
  The host's manifest names the extension's id, and the browser refuses to
  start it for anything else. `whiteboard native-host install` writes that
  manifest at user level (and, on Windows, a per-user registry key naming
  it).
- The packaged `stdio` MCP path does not use OAuth. Trust comes from the
  local process that launches the server.

What this does **not** protect against is a program running as your own
user: it can open the socket and read `daemon.json` exactly as the CLI
does. That is the same boundary as the rest of your home directory.

## Loopback origin squatting (browser storage)

A browser origin is defined by scheme + host + port, not by which process
currently answers on that port. On `http://localhost:<port>` (Vite's dev
port 5173 in particular is among the most commonly contended ports on a
developer machine), whatever process later binds that port inherits the
full origin — including everything IndexedDB and localStorage hold for it,
with no additional prompt or permission check. This is ordinary browser
origin semantics, not a Whiteboard-specific bug, and it is not something
this project can fix by itself.

None of this reaches the local daemon any more: the hosted app holds no
daemon credential in its storage, and a page reaches the daemon only
through the extension, which the browser runs apart from any page.

**This does not extend to canvas data itself.** A browser keeper's
canvases, files, and CRDT history in IndexedDB remain readable by whatever
later owns the origin — the same squatting scenario applies to your actual
canvas content, not only to daemon credentials, and there is no equivalent
fix available: the data has to live somewhere addressable by that origin
for the browser runtime to work at all. Treat a shared or
frequently-reused development port accordingly, and prefer the local
daemon (its own socket and token) over browser storage for
anything you would not want a future occupant of that port to read.

## Moving a workspace to the daemon

Moving a browser-kept workspace to a local daemon
([ADR-0023](../contributing/adr/0023-replica-model.md)) is a request through
the extension, carrying the daemon's credential like any other. The daemon
has one person, so there is nobody else for the move to be confirmed as, and
it is recorded without a passkey attestation. A move that does carry one is
refused (`attestation_rejected`), because no local daemon pins a passkey to
verify it against; [ADR-0039](../contributing/adr/0039-passkey-attestation.md)'s
attestation is not used by the local daemon.

## Replica key (offline read plane)

A browser can ask the daemon for a workspace's read-plane content key
(`POST /api/workspaces/:workspaceId/replica-key`), so it can keep an
encrypted offline replica and read it while the daemon is unreachable. What
this protects: a replica sitting on a device is ciphertext without the key.
On a local daemon the request arrives through the extension under the
daemon's own credential, so it is the machine's owner asking; the key is
kept per workspace so that the same mechanism serves server mode, where a
member who is removed must lose what their browser cached
([ADR-0050](../contributing/adr/0050-local-daemon-trust.md) decision 8).

**The daemon holds the key in plaintext.** It mints and stores the key itself,
so this is not end-to-end encryption from the daemon's point of view, and
product copy about it must never say "cryptographically revoked" — a key
withheld is withheld going forward, not invalidated retroactively. A
replica the browser already decrypted before removal keeps whatever it
already read; the protection is against a *future* fetch, not against
something already on disk.

Three tiers. `workspaces.replicaTier` is a per-workspace override:
`PUT /api/workspaces/:workspaceId/replica-tier` sets it, and `{ tier: null }`
clears it back to the `WHITEBOARD_REPLICA_TIER` default (see
[Configuration](../reference/configuration.md)). That route sits at the
`runtime:admin` bar — the same bar as membership and grant management —
rather than the `workspace:write` the rest of a workspace's fields sit
behind: a tier decides whether a copy of a workspace may leave the daemon at
all, which is an operator's call. That bar is cleared by the daemon token
(which the extension's requests carry) and by an operator-issued macaroon
carrying `runtime:admin`.

- `no-offline` — the daemon refuses to hand out a key for this workspace at
  all (`replica_not_allowed`).
- `offline` — the key is handed out with no expiry attached to the response.
- `bounded` — the key comes with a `leaseExpiresAt` timestamp. The daemon
  keeps no lease table server-side; honouring the lapse (discarding the key
  once it passes) is the browser's own responsibility.

**Rotation.** `POST /api/workspaces/:workspaceId/replica-key/rotate`
replaces the workspace's key and salt outright with a fresh random pair —
not an epoch bump on any document, which would leave the old workspace key
able to derive every old-epoch document key and deny nobody anything. This
is the response to a workspace key suspected compromised: every document
key derived from the OLD pair, and every browser replica sealed under it,
stops opening the moment rotation lands. Sits at the same `runtime:admin`
bar as the tier route above, and — deliberately — is not gated on tier at
all, so a `no-offline` workspace can still be rotated.

Say plainly what rotation does **not** do, matching the caveat above about
the daemon holding the key in plaintext: a browser tab that already holds
the old key in memory keeps reading with it, and keeps sealing new writes
under it, until it next asks the daemon and receives the rotated pair.
Whoever already copied the old ciphertext keeps it, along with the old key
that opens it — rotation denies a future read under the new pair, not a
past one. And every existing browser replica of this workspace becomes
unreadable and must be downloaded again in full; there is no partial
recovery.

A member sees which tier applies to a workspace they are viewing as a plain
sentence in **Settings → Connections → This workspace** — no jargon, no
mention of "tier", "replica", or "key". See
[Connect to a local daemon → See what this device keeps of a daemon-kept
workspace](../how-to/connect-to-local-daemon.md#see-what-this-device-keeps-of-a-daemon-kept-workspace).

**The browser half: sealed at rest, held only in memory.** Every daemon
workspace's replica is encrypted per chunk before it ever reaches IndexedDB —
a browser-kept workspace (and every single document, replica or not) stores
plain bytes as it always did, and the split is decided in one place
(`apps/web/src/lib/replica-store.ts`'s `openDocumentStore`). The session key
itself is never persisted in the clear: it lives in an in-memory holder for
the tab's life.

**A later tab can open the copy without the daemon, using the passkey.**
The key is wrapped under a value derived from a WebAuthn `prf` output and the
ciphertext is left beside the replica. For a local daemon reached through the
browser extension this is opt-in per copy: **Make readable offline** in
Settings creates a passkey in this browser only — never registered with the
daemon or sent to it — and wraps the key under its `prf` output. A cold start
then offers "Unlock with your passkey": one gesture, no network. What lands on disk is useless to whatever later owns the
origin, because the material that opens it exists only inside the
authenticator.

The cost is stated on the same screen, because it is real: **the passkey
provider becomes the recovery path.** Lose that credential and this device's
copy cannot be read again — the daemon still keeps the workspace, so a fresh
copy can be pulled, but what had not yet reached the daemon is gone. Support
for the extension is broad on platform authenticators and not universal; an
authenticator that ignores it still verifies the person, and only the cold
start is missing, leaving the earlier behaviour (the key lives for the tab's
life) exactly as it was.

A `bounded` lease
lapses client-side on the same clock check the daemon's own copy uses, and a
key withheld is felt at the next ask, not before: an already-read
replica stays readable in memory until the tab closes, matching the
plaintext-doesn't-mean-invalidated point above. A replica this browser
stored **before** this sealing shipped is plaintext on disk with no key ever
recorded to seal it retroactively — the next IndexedDB open (`DB_VERSION`
20) discards that record outright, chunks included, and the next daemon
resolve re-pulls it sealed.

**The offline read page shows one of five states**, decided from what the
daemon answered, what the in-memory key holder knows, and whether this
device remembered a wrapped key — never from a raw network error read
directly:

- **Needs a connection** — nothing is kept on this device yet.
- **Readable, daemon unreachable** — the key is held in memory (a session
  that began online); edits keep accumulating and ship to the daemon once
  it returns.
- **Locked, reconnect to unlock** — a copy is on this device, the key is
  not held, and nothing was remembered to open it with (a `bounded` lease
  that lapsed, or a copy never made readable offline); a Reconnect action
  re-asks the daemon and, if it answers, unlocks the same page without
  losing the person's place.
- **Unlock with your passkey** — a copy is on this device and a wrapped key
  sits beside it, so one gesture opens it with the daemon unreachable. The
  offer is withdrawn if the attempt shows nothing here can open the copy,
  rather than repeated.
- **Removed** — a keeper that has members (server mode) reached this
  device and refused the key as a membership refusal. The person is told
  plainly and offered no export and no retry that would send anything. A
  local daemon has one person and never answers this.

A reason the daemon never answered (an unreachable network, an expired
lease) never renders as removed: only a request the keeper actually reached
and refused does.

## Membership

A local daemon has no members: only its owner can open the owner-only
socket, so nothing is left for a passkey or a member list to tell apart
([ADR-0050](../contributing/adr/0050-local-daemon-trust.md), 2026-09-27
addendum decision 3). A daemon shared by several people is what server mode
is for, and server mode's people are the ones its Identity Provider signs
in.

## Daemon impersonation

A web page used to find the daemon by sweeping loopback ports, and any
process that won a swept port could answer as the daemon. There is no
longer anything to sweep: the extension's native host reads the daemon's
socket path from the owner-only `daemon.json` in the data directory it was
installed for, so it reaches that daemon and no other. A process that is
not the daemon would have to write that file — which means running as you,
the boundary described above.

## HTTP protections

- **Bearer token**: clients must send `Authorization: Bearer <token>` when token auth is enabled. The token is written to `daemon.json` in the data directory (`~/.whiteboard` by default) so the CLI, the stdio MCP server and the native host can locate the running daemon. The file is created with mode `0o600` (owner-read/write only) and is re-chmod'd after write on non-Windows platforms to counteract a permissive umask. Treat `daemon.json` as a credential file and ensure the data directory itself is not world-readable.
- **What may call `/mcp`**: the daemon's bearer token (full authority), and — when the daemon has no token configured — any local caller. A narrower credential the operator minted reaches `/mcp` only if it carries the `mcp:call` scope. A credential that verifies but lacks the scope is refused with `403` and no `WWW-Authenticate` challenge, because re-presenting it cannot help.
- **Security headers**: every response carries `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, and same-origin cross-origin headers.
- **Debug route gate**: `/api/debug` is hidden unless `WHITEBOARD_DEBUG=1` is set, and still requires Bearer auth when a token exists.
- **Stopping the daemon is a signal, not a request.** `whiteboard daemon stop` reads the pid and sends `SIGTERM` (escalating to `SIGKILL` after 5s), and the idle timer calls the server's own close directly. No HTTP route ends the process, so no credential does either. `runtime:admin` gates what remains — the keepalive and the log prune. It is **not** containment against a program running as your own user: anything running as you can read `ps` and signal the process, and no token refuses a signal.

## File-system safety

- Runtime data is stored under `~/.whiteboard` by default.
- Canvas identifiers are validated before they are mapped to file paths.
- Export and upload flows stay within daemon-controlled storage paths unless explicitly extended.

## Outbound requests (font installation — decided, not yet implemented)

The daemon makes **no outbound network requests today**. Every MCP tool operates
headlessly on persisted documents, and nothing fetches a remote resource.

[ADR-0012](../contributing/adr/0012-user-installed-fonts.md) decides the first
exception — installing a font the user chose — and the constraints below are
what keep it from becoming a general-purpose request forwarder. They are
recorded here because they are trust-boundary properties, not implementation
detail.

- **A family NAME is the input, never a URL.** The daemon builds the request
  from a pinned template, so the reachable hosts are a property of the code
  rather than of a validator over attacker-influenced input.
- **Only a user triggers it — it is not an MCP tool.** The daemon is driven by
  AI agents, and agents act on instructions found in the documents they read.
  A network primitive reachable from a tool call completes the chain
  *malicious document → agent → request into the user's network*. Keeping the
  trigger human removes it rather than bounding it. Exposing installation to
  MCP later requires re-deciding this, not extending it.
- **Redirects are not followed**, since an allowed host answering `302` would
  otherwise reach anywhere.
- **The stored filename is derived by the daemon**, never taken from the URL or
  a `Content-Disposition` header — the same rule as the export/upload paths
  above.
- **Size cap and timeout** bound a hostile or broken response.
- **The bytes must parse as a font before anything is written.** A file that
  `opentype.js` cannot parse never reaches the data directory.

## Browser-dependent operations

No current MCP tool requires a connected browser client — canvas editing
(`wb_canvas_edit` / `wb_facet_set`), reading
(`wb_canvas_snapshot`), rendering (`wb_scene_render`), reading and
writing content (`wb_document_get` / `wb_workspace_edit`), and versioning
(`wb_version_save` / `wb_version_restore` / `wb_version_list`) all operate on the
persisted document headlessly.

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
    `browser`) and which canvas identity is open. Never includes
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
  risk. The local daemon has no counterpart: it answers no browser origin.
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
