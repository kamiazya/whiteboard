# Security Model

Whiteboard runs in one of three runtimes, each with its own trust model:
**browser** (canvas data never leaves the browser's IndexedDB),
**local daemon** (loopback-only server for MCP/agent work, covered below),
and **server mode** (a shared server behind your own Identity Provider and
TLS, covered in its own section and in
[Self-host with Docker](../how-to/self-host-with-docker.md)). Do not read
one runtime's trust model as describing another — local-daemon tokens and
server-mode JWTs are separate credential systems and must never be mixed.

This page describes the **local daemon** in detail first, then server mode.

## Local daemon: trust boundary

- The daemon binds to `127.0.0.1` (not `localhost`) by default, restricting access to the loopback interface.
- HTTP routes under `/api/*` apply auth in two layers. First, a global middleware protects all mutation methods (`POST`, `PUT`, `PATCH`, `DELETE`) under `/api/*` except `/api/runtime/*`, which has its own per-router middleware. Second, `/api/runtime/*` routes are gated per the route-scope registry: `/api/runtime/ping` (liveness probe) and `/api/runtime/verify` (identity challenge) are public; read-only endpoints such as `GET /api/runtime/status` and `GET /api/runtime/storage` accept the daemon token, a scope-checked OAuth grant covering `runtime:read`, or an origin-bound pairing session token; the admin endpoint (`POST /api/runtime/logs/prune`) accepts the daemon token only — a paired web origin can inspect the daemon but never delete its logs. There is no HTTP route that stops the daemon. Canvas and workspace `GET` routes outside `/api/runtime/` are unauthenticated in local-daemon mode and serve canvas metadata to the local browser without requiring credentials.
- The `/mcp` HTTP transport applies token checks and restricts the `Origin` header to loopback addresses (`127.0.0.1`, `::1`, or `localhost`).
- The packaged `stdio` MCP path does not use OAuth. Trust comes from the local process that launches the server.

## Loopback origin squatting (browser storage)

A browser origin is defined by scheme + host + port, not by which process
currently answers on that port. On `http://localhost:<port>` (Vite's dev
port 5173 in particular is among the most commonly contended ports on a
developer machine), whatever process later binds that port inherits the
full origin — including everything IndexedDB and localStorage hold for it,
with no additional prompt or permission check. This is ordinary browser
origin semantics, not a Whiteboard-specific bug, and it is not something
this project can fix by itself.

The practical consequence: **connecting the hosted web app to a local daemon
now requires a fresh `#wb=` link every session.** This applies to pairing
from a hosted origin. (The daemon itself serves only the `/pair` consent
page at its own origin; every other UI path redirects to the official
hosted app.)

An earlier "silent reconnect" feature stored a possession credential (a
WebCrypto keypair, with a plaintext localStorage secret as a fallback for
older daemons) in the hosted origin's own browser storage specifically so a
reload would not require re-pairing. That credential is what a
port-squatting process could read or invoke —
a non-extractable `CryptoKey` does not need to be exfiltrated to be abused;
same-origin script can call `crypto.subtle.sign()` with it directly, and a
plaintext secret needs no cryptography at all. The feature has been
**removed entirely** rather than hardened, because eliminating the
credential is the only fix that does not depend on trusting the origin —
see [Connect to a local daemon → Pairing is required every
session](../how-to/connect-to-local-daemon.md#pairing-is-required-every-session)
for what this means day-to-day.

**This does not extend to canvas data itself.** A browser keeper's
canvases, files, and CRDT history in IndexedDB remain readable by whatever
later owns the origin — the same squatting scenario applies to your actual
canvas content, not only to daemon credentials, and there is no equivalent
fix available: the data has to live somewhere addressable by that origin
for the browser runtime to work at all. Treat a shared or
frequently-reused development port accordingly, and prefer the local
daemon (loopback-bound, its own token) over browser storage for
anything you would not want a future occupant of that port to read.

## Passkey attestation (moving a workspace to the daemon)

When you move a browser-kept workspace to a daemon, the daemon receives a
record it never witnessed being written. You can have that move confirmed by
a **passkey** (Face ID, Touch ID, Windows Hello, or a security key), and the
daemon records the confirmation beside the versions it creates — History
shows those as *verified*. This is
[ADR-0039](../contributing/adr/0039-passkey-attestation.md); the how-to is
[Connect to a local daemon](../how-to/connect-to-local-daemon.md).

What a passkey confirmation proves, and what it does not:

- **It proves a person was present.** The signature is made by the
  authenticator after user verification, over a challenge that names the
  target workspace and a digest of the exact bytes being moved. It says
  *someone satisfied user verification for this move of this content*. It
  does not say which machine they were at: a passkey may be synced across a
  person's devices, and the daemon records whether the credential is the
  syncable kind rather than assuming.
- **No private key enters browser storage.** The section above explains why
  a key kept in the hosted origin's storage would be worthless here: a later
  occupant of the origin could invoke it. A passkey's private key stays in
  the authenticator and cannot be invoked without the person's gesture, so
  same-origin script — including an agent running on the same page — can
  press the button but cannot produce the assertion. What the browser keeps
  is only the credential's identifier, so the next move can name it.
- **It does not protect the content.** Everything the squatting section says
  about canvas data still holds. An attestation stops content being passed
  off as a person's confirmed move; it does not stop the content being read
  or rewritten in the browser before the move.

How the daemon checks it: a passkey is registered from a paired origin, and
the daemon pins its public key for that origin (`webauthn-credentials.json`
in the data directory, alongside the pairing grants). A registration is
bound to the origin's host, so a passkey made at the hosted app does not
exist for the daemon's own `/pair` origin, and the other way round. Every
assertion is verified against that pin before the daemon merges anything —
a wrong signature, a challenge for another workspace, or a replayed
assertion (the authenticator's sign count did not advance) is refused, and
nothing lands. A move a browser cannot sign is REFUSED rather than recorded:
transferring a workspace to another keeper is confirmed with a passkey, and
a browser with none registered — or one that cannot hold one — cannot make
the move. Elsewhere in the log, absence still means the browser could not
ask rather than that anything was rejected; only the transfer requires the
evidence, because only there is the destination a keeper you may not own.

A **user-verification gate** — asking for a passkey before a browser-kept
workspace is shown on this screen — is designed but not shipped. When it
ships, its copy will say what it does and does not do: it hides content on
this screen from a shared machine, an unattended tab or someone looking over
a shoulder; it is not encryption, and a process that later owns the origin
still reads the storage directly.

## Replica key (offline read plane)

A member's session can ask the daemon for a workspace's read-plane content
key (`POST /api/workspaces/:workspaceId/replica-key`), so a browser can keep
an encrypted offline replica and read it while the daemon is unreachable. What
this protects: a replica sitting on a device is ciphertext without the key,
and a person removed from a workspace's membership is refused the key again
the next time their session asks for one — even though nothing about their
*existing* replica or its content changes at that moment.

The membership check applies only to a plain paired-browser session, and
only once a workspace **has** members. A workspace with none yet — the
common case before anyone has been added — hands out the key to a paired
session with no passkey required. Any request already trusted at the
daemon's own boundary (the daemon token, an open daemon with no token
configured, or an OAuth grant/token issued through the daemon's own consent
flow) always bypasses the membership check, member or no: none of those can
name a person to check membership for, and they already carry the daemon's
own authority.

**The daemon holds the key in plaintext.** It mints and stores the key itself,
so this is not end-to-end encryption from the daemon's point of view, and
product copy about it must never say "cryptographically revoked" — a removed
member's key is withheld going forward, not invalidated retroactively. A
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
all, which is an operator's call rather than something any member may relax
for everyone. Today that bar is cleared by the daemon token, an operator-
issued macaroon or OAuth grant carrying `runtime:admin`, and — the accepted
v1 posture already true of membership and grant management above — any
paired browser session, since a pairing grant currently carries every scope.
Narrowing what a pairing session may do is its own future increment, not
something this route does on its own.

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
When the session's own passkey assertion produces a WebAuthn `prf` output —
the same gesture that proves who is asking, never a second prompt — the key
is wrapped under a value derived from that output and the ciphertext is left
beside the replica. A cold start then offers "Unlock with your passkey": one
gesture, no network. What lands on disk is useless to whatever later owns the
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
membership revocation is felt at the next ask, not before: an already-read
replica stays readable in memory until the tab closes, matching the
plaintext-doesn't-mean-invalidated point above. A replica this browser
stored **before** this sealing shipped is plaintext on disk with no key ever
recorded to seal it retroactively — the next IndexedDB open (`DB_VERSION`
20) discards that record outright, chunks included, and the next daemon
resolve re-pulls it sealed.

**The offline read page shows one of six states**, decided from what the
daemon's renewal answered, what the in-memory key holder knows, and whether
this device remembered a wrapped key — never from a raw network error read
directly:

- **Needs a connection** — nothing is kept on this device yet.
- **Readable, daemon unreachable** — the key is held in memory (a session
  that began online); edits keep accumulating and ship to the daemon once
  it returns.
- **Locked, reconnect to unlock** — a copy is on this device, the key is
  not held, and nothing was remembered to open it with (a `bounded` lease
  that lapsed, or a session that never produced a `prf` output); a
  Reconnect action re-asks the daemon and, if it answers, unlocks the same
  page without losing the person's place.
- **Unlock with your passkey** — a copy is on this device and a wrapped key
  sits beside it, so one gesture opens it with the daemon unreachable. The
  offer is withdrawn if the attempt shows nothing here can open the copy,
  rather than repeated. It is never offered past a daemon decision: a
  refused renewal or a membership refusal is the daemon reaching this
  device, which is exactly when a revocation takes effect, and a local copy
  must not outrank it.
- **Unpaired** — the daemon was reached and no longer accepts this
  browser's pairing (the grant was revoked, or lost with the daemon's grant
  store). That says nothing about the person's membership, so the page says
  only that the device must be paired again; pairing starts from the
  daemon's own pair link.
- **Removed** — the daemon was reached and the replica-key request came
  back a membership refusal. The person is told plainly ("You were removed
  from this workspace; changes made since then were not sent") and offered
  no export and no retry that would send anything — discard-and-tell is
  the ban.

A reason the daemon never answered (an unreachable network, an expired
lease) never renders as removed or unpaired: only a request the daemon
actually reached and refused does. Every membership-gated route (below)
answers a removal the same way — the pairing route's refusal answers the
same way for a revoked grant and for a lost grant store, so neither is ever
read as a claim about the person.

## Membership gates online access

A workspace that has one or more members (ADR-0041 L1) admits its
document, sync and workspace-list routes only to a session bound to a
member's passkey — the same decision the replica key already checked, now
run on every ONLINE route that reaches the workspace's content. A
**member-less** workspace keeps origin trust: a personal daemon with no
members configured never needs a passkey, and every existing single-user
setup keeps working unchanged. Adding the first member is what flips a
workspace from origin trust to membership — see
[Connect to a local daemon](../how-to/connect-to-local-daemon.md) — and it
keeps origin trust only UNTIL its first member is added; removing every
member does not reopen it. A workspace that has ever had a member stays
person-gated, now admitting nobody until a member is added again.

**The gate has exactly one exit, and only the daemon's owner can take it.**
An operator can return a workspace to origin trust with
`DELETE /api/workspaces/:workspaceId/members-only`, which clears the marker
and leaves the memberships alone. It is barred to the **daemon token**,
judged by the credential's kind rather than by its scopes: a paired
browser's grant carries every scope today, so a scope-based bar would let
an origin reopen the very gate that exists to stop it being trusted. There
is no browser UI, and there cannot be one at that bar. It exists because
the gate otherwise has no way out — an operator who removes the last
membership, possibly their own, would be locked out of their own workspace
with no route back but editing the database by hand. Nothing beyond a log
line records that a reopen happened.

This applies to **local-daemon mode only**. Server-mode credentials are all
operator-issued through the external Identity Provider, which is already
trusted with everything; there is no separate person-vs-pairing distinction
to gate there.

**Exempt from the gate: operator-issued credentials.** The daemon token, an
open daemon's `anonymous` grant, an OAuth grant minted through the hosted
consent page, a macaroon minted from the daemon root key, and a
`ws-ticket` bridged from one of those — none of these can name a PERSON
(ADR-0041's subject), so gating them would be a permanent lockout the
moment a workspace gains its first member. Each already required the
operator's consent to mint.

**Also not gated**, on purpose, at a different bar than membership:
managing members, pairing grants and credential pins (any paired browser
session may do these — the accepted v1 admin posture, unrelated to who may
*read or write documents*), and the runtime/liveness surface (which carries
no workspace content).

**`GET /api/workspaces` filters rather than refuses.** Answering a full
list to a non-member and hiding only the documents inside it would still
leak every OTHER member's workspace name; the list a non-member sees
simply omits a workspace they are not a member of, the same way a search
result omits what you cannot read rather than showing a "forbidden" row
for it. The operator-issued daemon token sees every workspace, same as
today.

**What a removed person sees**: the same "You were removed from this
workspace" page the replica-key route's own removed state already shows
(ADR-0042 decision 4) — reached now from the online routes too, not only
from an offline replica. A session that has simply never bound its passkey
yet (`requires_person_session`) is asked for it once — a status message and
a "Try again" action — rather than shown either page; a second refusal in
the same page life falls to that same prompt again, never a silent retry
loop.

## Daemon impersonation (loopback port squatting, the other direction)

The section above concerns a process inheriting a browser ORIGIN. The
mirror case is a process impersonating the DAEMON: the hosted app can
sweep loopback ports to find one, and `/api/runtime/ping` is public and
its instance id is self-asserted, so any local process that binds a free
loopback port can answer it.

Pairing therefore authenticates one direction only — browser origin to
daemon, via a grant the user approves. The reverse (is this responder
really your daemon?) is **not** authenticated today. A squatter that wins
a swept port cannot touch the real daemon's data — grants, tokens, and the
data directory are per-daemon and separated by OS permissions — but it can
present itself for pairing and capture content the user creates afterward.

What the UI does about it:

- A responder this browser has never paired with is labelled
  "responded … (unverified)", never "your daemon is running". The app does
  not lend its own trust to an unproven claim.
- Approving a grant is always an explicit click on the responding daemon's
  own consent page, which shows the requesting origin.
- The trusted-direction bootstraps — the `wb_pairing_link_create` MCP tool, or
  opening the hosted app from the daemon itself — carry the base URL from the
  real daemon rather than from a port sweep, so the browser is pointed at the
  right responder instead of guessing. They carry no credential: the link
  still resolves through a pairing grant, and the identity pin above is what
  proves the responder. Prefer them when available.

Scope: this is about a local process that can bind a port but is not the
daemon. A full-privilege local attacker is outside this threat model (the
daemon already trusts the loopback interface and the OS user boundary) and
would read the daemon's data directory directly instead.

The durable fix is daemon-to-browser authentication: a daemon keypair
whose public half the ping advertises, with a signed challenge during
token exchange. Until that lands, discovery is convenience, not proof.

## HTTP protections

- **Bearer token**: local HTTP clients must send `Authorization: Bearer <token>` when token auth is enabled. The token is written to `daemon.json` in the data directory (`~/.whiteboard` by default) so the stdio MCP server can locate the running daemon. The file is created with mode `0o600` (owner-read/write only) and is re-chmod'd after write on non-Windows platforms to counteract a permissive umask. Treat `daemon.json` as a credential file and ensure the data directory itself is not world-readable.
- **Origin checks**: `/mcp` only allows loopback browser origins (`127.0.0.1`, `::1`, or `localhost`) for local HTTP use. All three resolve to the same loopback interface; allowing `localhost` is consistent with browser behavior across platforms.
- **Hosted web-app pairing**: a browser app served from a non-loopback (hosted `https:`) origin can still pair with the local daemon, but only from an admitted origin. The official hosted web app (`https://kamiazya-whiteboard.pages.dev`) is admitted by default — admission is CORS-level only, and data access still requires a pairing grant approved on the daemon's consent page. Any other origin must be listed in `WHITEBOARD_ALLOWED_WEB_ORIGINS` (which, when set, replaces the default; an empty value opts back into loopback-only) — a comma-separated, HTTPS-only allowlist whose entries are exact origins or `https://*.example.com` leftmost-label wildcard subdomain patterns (bare `*` is never permitted; see [Configuration → Wildcard subdomain patterns](../reference/configuration.md#wildcard-subdomain-patterns)). Loopback origins need no allowlist entry. This env var governs the local daemon only; it is unrelated to server mode's origin allowlist below.
- **What may call `/mcp`**: the daemon's bearer token (full authority), and — when the daemon has no token configured — any local caller. An OAuth client, or a narrower token the daemon issued, reaches `/mcp` only if the credential carries the `mcp:call` scope, which the consent page shows as "Call MCP tools". A credential that verifies but lacks the scope is refused with `403` and no `WWW-Authenticate` challenge, because re-presenting it cannot help. A hosted web app's pairing grant does **not** reach `/mcp` at all, whatever scopes it holds: a paired browser origin talks to `/api/*`, and nothing in the web app speaks MCP.
- **Security headers**: the app serves `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, and same-origin cross-origin headers.
- **Debug route gate**: `/api/debug` is hidden unless `WHITEBOARD_DEBUG=1` is set, and still requires Bearer auth when a token exists.
- **Stopping the daemon is a signal, not a request.** `whiteboard daemon stop` reads the pid and sends `SIGTERM` (escalating to `SIGKILL` after 5s), and the idle timer calls the server's own close directly. No HTTP route ends the process, so no credential does either. `runtime:admin` gates what remains — the keepalive and the log prune — and that is a real boundary against a caller not running as you, such as an OAuth client or a paired web origin. It is **not** containment against a program running as your own user: anything running as you can read `ps` and signal the process, and no token refuses a signal. Narrowing what a local agent holds is worth doing; it does not make the daemon un-stoppable by that agent, and any copy claiming otherwise is wrong.

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
