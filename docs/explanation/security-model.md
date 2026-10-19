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
- **Clients check the socket before they send the token.** A record can
  outlive its daemon (a crash, a kill, a power loss), and after a reboot
  empties the temp directory another user could recreate
  `whiteboard-<uid>` there and listen at the recorded path. So before a
  client sends the token to a Unix socket, it checks that the socket's
  directory is a real directory owned by this user and owner-only (`0700`),
  and that the socket is owned by this user and is not a symbolic link. The
  directory is checked even when no socket is there yet, because another
  user could swap their own directory for one holding their socket between
  the check and the connection. If any of that fails, the client sends
  nothing to the socket and reports that it may belong to another user, and
  how to move the socket somewhere of your own (`XDG_RUNTIME_DIR`, or
  `TMPDIR` when that is unset). `whiteboard daemon run` and `daemon stop`
  then leave the record alone and signal no process, and the native host
  relays nothing. When the directory does not exist at all, the client
  sends nothing either, since whoever creates it next decides what answers
  there. If the recorded pid now belongs to a process that started after
  the record, the record is treated as stale. If the pid may still be the
  daemon (a temp-directory cleaner can remove the directory under a live
  daemon), the daemon is reported as not confirmed rather than running:
  `daemon status` and `daemon doctor` say the socket directory does not
  exist, the native host relays nothing, and `daemon run` and `daemon stop`
  leave the record and the process alone. Stop that process yourself, then
  start the daemon again. The check is repeated immediately before each
  request that carries the token — by the CLI and by the native host for
  every request it relays — so a directory replaced after the record was
  read still receives nothing.
- **Every client reaches it there**: the CLI, the stdio MCP entry, and the
  native messaging host that the browser extension starts. A web page never
  talks to the daemon over HTTP, and the daemon serves no page — there is no
  consent page, no pairing, no browser `Origin` to judge and no CORS.
- **The daemon's bearer token is the credential.** `/api/*` and `/mcp`
  require it when one is configured (as `whiteboard daemon run` always
  does). The native host reads it from `daemon.json` and attaches it
  itself, so the page never holds it. The route-scope registry also judges
  a scoped macaroon, should one be presented — enforcement only: nothing
  mints one today
  ([ADR-0043](../contributing/adr/0043-authority-as-keys.md)
  withdrew the minting route).
  `/api/runtime/ping` and `/api/runtime/proof` (the token proof described
  under Current limitations, which reveals nothing of the token) are public;
  there is no HTTP route that stops the daemon.
- **The browser starts the native host only for the whiteboard extension.**
  The host's manifest names the extension's id, and the browser refuses to
  start it for anything else. `whiteboard native-host install` writes that
  manifest at user level (and, on Windows, a per-user registry key naming
  it).
- **The development build of the extension has an id of its own.** It
  admits `localhost` and `127.0.0.1` pages, which any user of the machine
  can serve, so a host installed for everyday use does not start for it.
  Only a development install allows that id, and it refuses to run without
  a directory you name, so it cannot replace your browsers' own
  registration:
  `whiteboard native-host install --json --development --manifest-dir=<dir>`
  (or `--firefox-manifest-dir=<dir>`).
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
it is recorded without a passkey attestation. The move's request has no
field for one, and a request that carries one anyway is refused as an invalid
body, because no local daemon pins a passkey to verify it against;
[ADR-0039](../contributing/adr/0039-passkey-attestation.md)'s attestation is
not used by the local daemon.

## Replica key (offline read plane)

A browser can ask the daemon for a workspace's read-plane content key
(`POST /api/workspaces/:workspaceId/replica-key`), so it can keep an
encrypted offline replica and read it while the daemon is unreachable. What
this protects: a replica sitting on a device is ciphertext without the key.
The request arrives through the extension under the daemon's own
credential, so it is the machine's owner asking. **Only the local daemon
serves the replica-key routes**: server mode does not mount them, so it hands
out no read-plane key. The key is kept per workspace so that a keeper with
members could withhold it from one who was removed
([ADR-0050](../contributing/adr/0050-local-daemon-trust.md) decision 8), but
no shipped keeper does that today.

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
(which the extension's requests carry); a scoped macaroon carrying
`runtime:admin` would clear it too, and none is minted today.

- `no-offline` — the daemon refuses to hand out a key for this workspace at
  all (`replica_not_allowed`).
- `offline` — the key is handed out with no expiry attached to the response.
- `bounded` — the key comes with a `leaseExpiresAt` timestamp. The daemon
  keeps no lease table server-side; honouring the lapse (discarding the key
  once it passes) is the browser's own responsibility.

An operator sets or clears one workspace's override with
`whiteboard daemon set-replica-tier --json --workspace=<id|handle/segment|segment> --tier=<no-offline|offline|bounded|default>`;
`default` clears it, back to `WHITEBOARD_REPLICA_TIER`, and the answer
echoes both the override and what the workspace resolves to.

**Rotation.** `whiteboard daemon rotate-replica-key --json --workspace=<id|handle/segment|segment>`
(the operator's entry point; it asks the running daemon's
`POST /api/workspaces/:workspaceId/replica-key/rotate` over the daemon's
socket under its token) replaces the workspace's key and salt outright with
a fresh random pair —
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

The browser says so rather than reporting damage. Each device records which
key a cached copy was sealed under, and the next time it reaches the daemon
and is handed the new key it sees the two differ: it discards the old copy,
downloads the workspace again, and records the new key. A copy that cannot be
opened for that reason is shown as "the daemon changed how this workspace is
protected, so this copy has to be downloaded again", never as a damaged
document. Two consequences to expect: edits made offline on that copy and not
yet sent are lost with it, and "make readable offline" has to be turned on
again for the workspace, because the passkey-wrapped key it relied on opened
the old copy only.

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

**The offline read page shows one of six states**, decided from what the
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
- **Removed** — a keeper that has members reached this device and refused
  the key as a membership refusal. The person is told plainly and offered no
  export and no retry that would send anything. No shipped keeper answers
  this: the local daemon has one person, and server mode serves no replica
  key.
- **Download again** — the daemon rotated the workspace key after this copy
  was saved, so nothing on this device can open it. The copy is not damaged;
  the page says it has to be downloaded again from the daemon, and offers a
  Reconnect. No passkey turns this into an unlock, because the wrapped key
  it opens is of the replaced key as well.

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
- **What may call `/mcp`**: the daemon's bearer token (full authority), and — when the daemon has no token configured — any local caller. A scoped macaroon would reach `/mcp` only with the `mcp:call` scope (none is minted today), and each tool it calls would still need the scope its `/api` twin does — a macaroon scoped `mcp:call` and `canvas:read` is refused a write tool with `insufficient_scope`, as server mode refuses a bearer. A credential that verifies but lacks the scope is refused with `403` and no `WWW-Authenticate` challenge, because re-presenting it cannot help.
- **Security headers**: every response carries `frame-ancestors 'none'` (unless the route sets its own CSP), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, `Cross-Origin-Resource-Policy: same-origin` and `Cross-Origin-Opener-Policy: same-origin`. One page relaxes the opener policy: server mode's transfer receiver (`/receive-transfer`) is a popup another origin opens and answers through `window.opener.postMessage`, which `same-origin` would sever, so it is served `unsafe-none` and checks every message's origin and nonce itself. It takes an offer from any web origin, so before any Accept control exists it asks the person whether they started the transfer, naming the sending origin; declining tells the sender only that it was declined, and accepting still needs the target workspace chosen explicitly, since none is preselected.
- **Debug route gate**: `/api/debug` is hidden unless `WHITEBOARD_DEBUG=1` is set, and still requires Bearer auth when a token exists.
- **Stopping the daemon is a signal, not a request.** `whiteboard daemon stop` reads the pid and sends `SIGTERM` (escalating to `SIGKILL` after 10s), and the idle timer calls the server's own close directly. No HTTP route ends the process, so no credential does either. `runtime:admin` gates what remains — the debug routes, a workspace's replica posture (key rotation and tier) and font installation. It is **not** containment against a program running as your own user: anything running as you can read `ps` and signal the process, and no token refuses a signal.

## File-system safety

- Runtime data is stored under `~/.whiteboard` by default.
- Canvas identifiers are validated before they are mapped to file paths.
- Export and upload flows stay within daemon-controlled storage paths unless explicitly extended.

## Outbound requests (font installation and the search model)

No MCP tool makes an outbound network request: every one operates headlessly
on persisted documents, and nothing the daemon serves fetches a remote
resource on a tool call's behalf. Two things a person does reach out:

- **Installing a font** (`POST /api/fonts/:id/install`) downloads one
  catalogued font file from `raw.githubusercontent.com` (the Google Fonts
  repository), with a five-minute timeout and a 32 MiB cap.
- **`whiteboard search fetch-model`** downloads the semantic-search model
  weights from Hugging Face, once, when an operator runs it. The daemon never
  downloads them itself ([Find documents from chat](../how-to/find-documents-from-chat.md)).

[ADR-0012](../contributing/adr/0012-user-installed-fonts.md) decides the first,
and the constraints below are what keep it from becoming a general-purpose
request forwarder. They are recorded here because they are trust-boundary
properties, not implementation detail.

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

## Math and diagrams drawn from document text (web app)

The web app typesets `$$` math blocks and draws `` ```mermaid `` fences in the
note preview, the canvas editor and the SVG/PNG exports, and the SVG it gets
back is placed into the page as markup. Document text decides what goes into
that SVG, so it is held to what SVG text can do:

- Mermaid runs at its `strict` security level with HTML labels off, and a
  diagram's own `%%{init}%%` directive cannot turn them back on, inject CSS
  (`themeCSS`), choose a font (`fontFamily`, at any depth of the directive) or
  loosen the label sanitiser. It can still pick a theme and its colours. A
  label is drawn as SVG text, so HTML written in one shows as its source.
- MathJax runs without its `html`, `bbox` and `unicode` extensions, and
  without `require`, which could load one back. So `\href`, `\class`,
  `\cssId`, `\style`, `\bbox` and `\unicode` are not commands: math cannot
  carry a link, or put an id, a class, an inline style or a font of its
  choosing into the page. Written in a math block, they show as unknown
  commands. `\mmlToken` still sets a token's own MathML attributes, but the
  `id`, `class`, `style`, `href` and `fontfamily` it would also accept are
  dropped before the math is drawn.
- Whatever either engine returns is checked before it is used: a fragment
  carrying an HTML island (`<foreignObject>`), a form, a script, an
  animation element (`<animate>`, `<set>` and the rest, which could rewrite a
  link after the check has read it), an event handler, an `action` or
  `formaction` attribute, any `href`, `src` or `url(…)` that points outside
  the fragment, quoted or not, or CSS that check cannot read — a backslash
  escape in a `style` attribute, or an `@import` — is refused, and the block
  keeps its source.
  This matters beyond the app: an exported SVG opened on its own has no
  content security policy behind it.
- The hosted app's policy carries `form-action 'none'`: nothing in the app
  submits a form natively, so a form that did reach the page would have
  nowhere to post.

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
- Cross-origin access to **`/mcp`** is restricted by
  `WHITEBOARD_SERVER_ALLOWED_ORIGINS`, an explicit `https://` allowlist
  (defaulting to `WHITEBOARD_SERVER_EXTERNAL_URL` when unset); `/mcp` is the
  only path that answers CORS. `/api` and `/auth` answer no CORS at all, and a
  sign-in session authenticates a write (any method but `GET`, `HEAD` or
  `OPTIONS`) only when the request's `Origin` is the server's own origin —
  otherwise the session is ignored and the request needs a bearer token.
  Reads are held to the browser's `Sec-Fetch-Site` header where it is sent:
  the session counts only for `same-origin` (this server's own pages) or
  `none` (a navigation the user started), so a page on a sibling subdomain
  cannot spend a signed-in person's live-sync streams. A client that sends
  no `Sec-Fetch-Site` reads with the session as before.
  Allowlist entries may be exact origins
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

- **Each MCP tool needs its `/api` counterpart's scope.** `/mcp` needs
  `mcp:call`, and a tool call also needs the scope the same operation needs
  over HTTP, or it is refused with `insufficient_scope` before it runs. The
  table is [Scopes a bearer token needs on `/mcp`](../how-to/self-host-with-docker.md#scopes-a-bearer-token-needs-on-mcp).
- **Adding, removing or moving a document needs `workspace:write` on every
  surface, and so do the trash and the pins.** `canvas:write` edits what
  documents say. A live-sync update is read before it is applied: one that
  would add, delete or move a document, purge, restore or rewrite a trash
  entry, change which documents are pinned, or write anything else in the
  workspace record outside its documents, or that addresses a path no
  document holds, is refused with `403` unless the grant also holds
  `workspace:write`, and nothing of it is kept. One the grant does allow
  to remove a document still cannot destroy it: the daemon puts each
  document the update removes in the trash, as its own delete does, before
  keeping the update, so the content stays restorable and its saved versions
  stay reachable. A document's own update
  cannot reach its place in the workspace either: one that adds a part named
  after the document's id, segment, kind, name or timestamps, or a part of
  the wrong kind under a name the document already uses, is refused with
  `400 {"error":"invalid_document_root"}`, and so is a workspace update, from
  any caller, that leaves one of a document's content parts (its nodes, body,
  threads and the rest) holding a plain value, a part of another kind, or
  nothing. A
  live-sync update is judged after it is taken into the keeper's working
  copy, so one the keeper cannot finish judging — a check that fails rather
  than answering, or a save that fails — is dropped with that copy unsaved,
  exactly as a refused one is, and never rides a later save. So is one
  that builds on a change the keeper does not hold: the engine would park
  those changes where no check reads them and apply them once the gap
  filled, so the update is answered `409` (`causal_gap`) and kept nowhere,
  and the client sends it again once the keeper holds what it builds on. The
  same answer meets an update that writes into a part of a document created
  by a change the update does not build on: no check could find where such
  writes sit until a later change attached the part. Moving
  a whole workspace in needs `canvas:write`, `workspace:write` and
  `versions:write`.
- **A version grant restores in place, and writes no other document.**
  `versions:write` restores a document to one of its own saved versions. A
  restore into another path, or of a whole subtree, creates, replaces or
  deletes other documents, so it also needs `workspace:write` — over HTTP
  and through `wb_version_restore` alike — and is refused with
  `insufficient_scope`, writing nothing, without it.
- **A tool call tells its caller what went wrong, not how.** A failed call
  answers a member with the refusal or a generic fault, never the storage
  path, SQL or engine detail behind it. The server's log records are not
  forwarded to them over MCP logging either, since a record can carry a raw
  error or another user's ids; the operator reads them on stderr.
- **What describes the whole server is an administrator's.** The runtime
  status (the process and every user's open live-sync streams) and the
  storage report (every workspace's size) answer only a tenant
  administrator. Any other signed-in person is refused, even though their
  session holds the `runtime:read` scope that the font catalogue needs.
- **A workspace's people are changed only through a browser sign-in.** An
  owner adds, re-roles and removes people, mints and takes back invitation
  links, and changes the workspace's segment from the web app while signed
  in. The same owner presenting a bearer token — even one scoped
  `workspace:write` — is refused with `403 sign_in_required` and nothing
  changes; no invitation link is minted. That is the bar tenant
  administration holds. A bearer still reads a workspace's people and still
  changes its display name.
- **Authority is checked again as a change is made.** A request is
  authorized when it arrives, and its change lands later. Every change an
  administrator makes to a tenant's people — deactivating, reactivating,
  deleting, appointing and dismissing — and every change an owner makes to a
  workspace's people — adding, changing a role, removing, taking back an
  invitation link — asks again, as it is made, whether the actor still holds
  that role. One dismissed, demoted, removed or deactivated in between is
  refused and changes nothing. An invitation link is checked the same way
  when it is accepted.
- **An invitation is accepted on this server's own invite page.**
  Accepting is a click there, which the page sends as a `POST` that only
  this server's own pages can make (its `Origin` must be this server's).
  No link can accept one: a sign-in link carrying an invitation — from
  another site, from inside a document on this server, from a mail client —
  is sent to the `/invite` page instead. So a link cannot silently join a
  person already signed in at the provider to a workspace and land them in
  it.
- **A live-sync stream belongs to the user who opened it.** Only that user
  may subscribe it to a workspace, the instance re-checks membership and
  deactivation before sending each update and ends the stream when either
  fails, and open streams are capped per user and per instance. A stream
  also ends when the grant that opened it expires — the sign-in session's
  expiry, or a bearer token's `exp` — even if nothing is sent down it; the
  web app then reconnects, and the new stream needs a grant that is still
  valid. A stream opened on a sign-in session also ends when that session
  does: signing out, or signing in again in the same browser, ends the
  previous session's streams on the instance that handled it. A stream that
  another instance holds keeps running until the session's expiry. The limits
  are [Live-sync stream limits](../reference/configuration.md#live-sync-stream-limits).
- **Server mode reads a bounded number of large bodies at once.** A sync
  update, a promote, an upload, a document created from its content or a
  JSON-RPC request to `/mcp` is read whole before it is applied, so the
  bodies in flight are capped per user and per instance, and the next one is
  refused before it is read. Callers whose grant names no user on the
  instance share one user's allowance. The limits are
  [Large request limits](../reference/configuration.md#large-request-limits).
- **A restore from the trash is held to the bounds of any other write.** A
  trash entry syncs with the workspace and a move carries the bytes it names,
  so both are the writer's choice: a restore that would place a document at a
  path outside the path grammar, give it a name past the length limit, or
  bring back a body or node text past its limit is refused and changes
  nothing, in the browser and on the daemon alike.
- **Rewriting references is held to the same text bounds.** Linking a
  document's mentions, or following a move into the documents that name the
  old path, never leaves a body or a node's text past its limit: Link
  refuses and writes nothing, and a move leaves such a document as written,
  which the daemon reports. The details are in
  [Export formats](../reference/export-formats.md#how-large-a-markdown-document-may-be).
- **A saved version is held to the bounds of any other write.** A move into
  the daemon carries the browser's saved versions, each naming a past state
  of the record, and a sync write is judged only on the state it leaves. So
  the daemon judges each carried version's state too, and refuses the move
  whole — in the same error a sync write gets (`markdown_too_large`,
  `too_many_nodes_or_edges`, …) — when one holds a body, node text, label or
  board past its limit. A restore judges the state it is about to write the
  same way, in every mode, and refuses with that error before writing
  anything.
- **An MCP tool reads only a document its named workspace holds.** A
  `documentId` paired with a `workspaceId` that does not place it is refused
  as not found, by the read tools as by the write tools.
- **What a member is answered carries no storage detail.** A fault answers a
  fixed message and goes to the operator's log with its detail; an export
  names its file within the workspace's exports directory, not the absolute
  path.
- **A PNG export is bounded in pixels, and reads no host file.** Two things
  are bounded before anything is drawn: the size of the picture the export
  produces, and the pixels the inline images it carries declare between them,
  read from each image's own header. An export past either budget is
  refused. An image whose type the exporter does not draw, or whose header it
  cannot read, is left out rather than trusted to be small, and so is an SVG
  image asking for filter effects, whose drawing time its size does not
  bound. An inline
  Markdown image draws in a PNG only from a `data:` URL — the exporter never
  reads a file the URL names on the server, nor fetches a remote one. What is
  NOT bounded is time: the drawing itself runs in the serving process with
  no deadline. All of it is in
  [Export formats](../reference/export-formats.md).
- **A render lays out a bounded number of embedded documents.** Embeds nest
  three levels deep, and one render lays out at most 128 embedded documents
  across every level and both kinds of embed (a file node's canvas preview,
  a `![[…]]` in a body). The canvases those embeds draw lay out at most
  4000 elements (nodes, edges and lines) between them — one maximal board's
  worth — so a hub naming one maximal board many times draws it once, not
  once per embed. So a workspace whose documents each embed many others
  cannot make one render cost the cube of its fan-out, nor a multiple of its
  largest board. Past either budget an embed draws as its placeholder or
  card. The budget holds for
  `wb_scene_render`, export and the web app's preview alike.
- **A move into the daemon is bounded.** Moving a browser workspace to the
  daemon is one request of at most 24 MiB carrying at most 2000 documents,
  2000 trashed documents and 120,000 saved versions. The daemon counts all
  three before it judges or merges anything, and refuses a larger move whole
  (`promote_too_many_documents`, `promote_too_many_carried`). Each saved
  version is checked against the record before the merge, and rows naming
  the same document at the same point are checked once, so repeating one row
  costs almost nothing. So one request cannot make the daemon write, or
  check, an unbounded number of saved versions.
- **A workspace holds a bounded number of documents.** The 2000-document
  ceiling holds for the workspace as a whole, however the documents arrive: a
  sync update or a move that would leave the workspace holding more is
  refused whole (`too_many_documents`), and so is each single new document —
  a create through `/api/v1` or `wb_workspace_edit`, a document's update to a
  new path, a duplicate, a trash restore — so repeating small writes cannot
  grow a record without limit either. The documents one update edits are
  checkpointed one at a time, not all at once. Folders are bounded the same
  way, at 4000 (`too_many_folders`), since every listing walks them as it
  walks documents, and each folder's path is held to the 1,024-character path
  bound a document's is (`invalid_path`), which bounds how deep the tree can
  nest. A record stored before either bound still lists.
- **A canvas holds a bounded number of nodes, edges and lines.** Every render,
  export and tidy lays the whole board out again on the serving loop, so one
  board holds at most 2000 nodes and 2000 edges and lines together (a line is
  routed like an edge and costs the same), however the change arrives:
  `wb_canvas_edit` refuses the op that would pass either, and a sync update
  or a move is refused whole (`too_many_nodes_or_edges`). One batch tidies at most
  once, so a single call cannot repeat a whole-board layout once per op.
  The overlay on top of the board is bounded the same way: a document holds
  at most 500 open comment threads and 1000 open proposed changes, counted
  across all of its proposals (`too_many_open_threads`,
  `too_many_open_changes`). Resolved threads are not counted, since the
  daemon never draws them; a reader who asks the web app to show resolved
  comments lays all of them out in their own browser. What every render
  does read of every thread, resolved ones included, is a node-set anchor,
  so one anchor names at most 2000 nodes (`comment_anchor_too_large`). What
  is still NOT bounded is how long the largest permitted board takes to lay
  out — several seconds on a typical machine — and that work blocks the loop
  while it runs. All of it is in
  [Export formats](../reference/export-formats.md).
  On a server running several instances these ceilings are checked by each
  instance on its own, so writes landing at once through different
  instances can together pass one; see
  [Running several instances](../how-to/self-host-with-docker.md#running-several-instances).
- **The data directory answers to the operator.** The stdio entry and the
  local daemon require a data directory owned by this user, refuse one that
  is a symlink rather than follow it, and make it owner-only. Server mode leaves its ownership and mode as the operator set
  them: a platform volume may be owned by another user and shared through a
  group, and a bind mount is often opened to every uid so the container's
  user can write it. Keeping that directory closed to other users of the
  host is the operator's to arrange.

## Current limitations

- **On Windows the daemon's named pipe is not owner-only.** Node creates the
  pipe through libuv, which calls `CreateNamedPipeW` with no security
  attributes, so the pipe gets Windows' default security descriptor: full
  control for LocalSystem, administrators and the creator owner, and read
  access for the Everyone group and the anonymous account
  ([named pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)).
  Node offers no option that narrows it — `readableAll`/`writableAll` only
  widen it, and the daemon sets neither. Read access does not include write
  access, so another account cannot send the daemon a request over the
  pipe, and every request but `/api/runtime/ping` and `/api/runtime/proof`
  also needs the bearer token. The random pipe name defeats creating the
  pipe first; it does not hide the pipe, since pipe names can be listed. The
  Unix socket's owner-only directory has no equivalent here.

  A daemon that dies without removing `daemon.json` (a crash, a kill, a
  power loss) releases its pipe name, and another account can then create a
  pipe under it. Windows also cannot say when a process started, so a live
  pid in the record proves nothing about who now serves the pipe. Before a
  client sends the token to a pipe, it therefore asks the pipe to prove that
  it holds the token: it sends a random nonce to `/api/runtime/proof`
  without any credential, and the daemon answers with an HMAC-SHA256 of the
  nonce, keyed by the token. Only an answer that verifies against the
  record's token counts. A pipe that answers anything else is refused, and
  the client reports that a process holds the pipe without confirming it is
  the recorded daemon. A pipe nobody serves is treated as a stale record.
  The token itself never travels until the proof succeeds. On Linux and
  macOS there is no proof: clients check instead that the socket's directory
  is still owner-only and the socket is this user's (see the trust boundary
  above).

- Server mode is shipped and used today for team/remote deployments (see
  above); it is not itself production-hardened beyond what is documented on
  this page — treat it as "usable with a competent operator," not
  "zero-configuration safe."
- Storage quotas, telemetry policy, and remote threat-model docs are still
  separate follow-up items: this page describes trust boundaries and
  protections as implemented, not a vetted threat model for adversarial
  remote environments.
