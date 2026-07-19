# Connect the web app to a local daemon

The web app (`apps/web`) can run entirely in the browser with no daemon —
canvases are stored in IndexedDB and never leave the device. This guide
covers what happens once a local daemon (started via `whiteboard mcp` or an
MCP client) is also running on the same machine, and how to move a
browser-local canvas onto it.

The web app UI calls these "variations" and "combining changes," but the
underlying MCP tools your AI agent calls (`create_branch`, `merge`, and so
on) intentionally keep their git-derived names — the UI vocabulary is a
presentation-layer choice and does not change the tool contract.

## Opening the daemon's own UI directly

The local daemon serves the canonical `apps/web` build at its own origin —
open `http://127.0.0.1:<port>/` (default port `3099`) in a browser and it
renders the same canvas gallery and editor as a standalone `apps/web` deploy,
already same-origin with the daemon's `/api/*`, `/mcp`, and WebSocket routes.
No pairing link or Local Network Access prompt is needed for this path.

Running `whiteboard daemon run` interactively opens this URL in your default
browser automatically once the daemon is listening, so there is no separate
step even for a human with no AI agent in the loop. Pass `--no-open` (or set
`openBrowser: false` in a [config file](../reference/configuration.md#config-file-local-daemon))
to disable this. See
[Auto-opening the browser](../reference/configuration.md#auto-opening-the-browser-whiteboard-daemon-run)
for the full list of conditions under which it is suppressed (CI, containers,
non-interactive shells, non-loopback binds).

- **No service worker on this origin.** The daemon injects a per-request
  `__WHITEBOARD_RUNTIME_CONFIG__` and `__WHITEBOARD_DAEMON_TOKEN__` into every
  response; a Workbox-precached shell would pin a stale token across daemon
  restarts, so the daemon-served build ships without the offline service
  worker that a standalone `apps/web` deploy installs.
- **Loopback-only live sync.** The injected daemon base URL for the
  WebSocket connection is always `http://127.0.0.1:<port>` — a fixed loopback
  address, not whatever host or IP the browser used to reach the page. If you
  bind the daemon beyond loopback (for example `--host 0.0.0.0`) and open its
  UI from another device on the LAN, the page loads but its live-sync
  WebSocket still tries to reach `127.0.0.1` on *that device*, which is not
  the daemon — sync silently fails. This same-origin UI is intended for
  local, same-machine use; reach a daemon from another device through the
  pairing flow below instead.

## How detection works

The web app probes `GET /api/runtime/ping` on the daemon's default loopback
origin (`http://127.0.0.1:3099`, or a custom `localDaemonBaseUrl` from your
settings). That endpoint is unauthenticated and only confirms a daemon is
listening — it does not grant access to any workspace or canvas data.

- On an `http:` page origin (the common case for local development), the
  probe runs automatically once per browser session.
- On an `https:` page origin, the browser's Local Network Access permission
  model requires an explicit user gesture before a page can reach a loopback
  address, so the probe only runs when you click **Check for local daemon**.

If a daemon is detected, a banner offers to connect. Dismissing it hides the
banner for 14 days or until a different daemon instance is detected,
whichever comes first.

## Browser support for daemon pairing

Whether your browser can reach a loopback daemon from a hosted `https:` page
depends on capability, not a fixed version list:

- **Any browser on an `http:` loopback page origin** (the common local
  development setup) can always reach the daemon — there is no cross-scheme
  restriction to work around.
- **Chromium-based browsers on a hosted `https:` origin** can reach the
  daemon once you grant the Local Network Access permission prompt.
- **Firefox on a hosted `https:` origin** can reach the daemon without an
  extra permission prompt, because Firefox does not yet gate loopback
  fetches behind Local Network Access.
- **Safari/WebKit on a hosted `https:` origin cannot reach the daemon.**
  WebKit blocks the request as mixed content with no override. On this
  browser, canvases stay in this browser (IndexedDB) — the app shows an
  explicit notice instead of a silently missing "connect" option, with a
  link to open the local app directly (see below).

This is determined by probing the daemon, not by inspecting your browser's
identity string: the app only shows the "not supported" notice once a probe
has actually proven the browser blocked the request.

**The way out on an unsupported browser: open the daemon's own origin.** The
mixed-content/private-network block above applies only to the background
`fetch` the app uses to detect a daemon — it does not apply to a normal
top-level navigation. So on Safari (or any future engine with the same
restriction), click the "Open the local app" link in the notice, or type the
daemon's address directly into the address bar (`http://127.0.0.1:3099` by
default). That loads the same `apps/web` build served same-origin by the
daemon, described in
[Opening the daemon's own UI directly](#opening-the-daemons-own-ui-directly)
above, where every feature — including live daemon sync — works normally.

## How pairing works

Detecting a daemon is not the same as pairing with it. Actually connecting
the web app's canvas editor to a specific workspace requires a pairing link,
which the web app cannot mint itself — it can only detect that *a* daemon is
reachable and prompt you toward the pairing flow below.

1. Ask your AI agent (Claude, Codex, or any MCP client connected to the
   whiteboard daemon) to call the `create_pairing_link` MCP tool. Optionally
   pass `workspaceId` / `slug` to target a specific canvas, or `webOrigin` to
   point at a non-default web app deployment.
2. The tool returns a URL carrying a `#wb=` fragment with a short-lived
   bootstrap token (see [ADR-0002](../contributing/adr/0002-browser-to-daemon-transport.md)
   for the transport design). Open that URL in your browser.
3. On a hosted `https:` origin, the browser's Local Network Access permission
   prompt appears — grant it to let the page reach your loopback daemon.
4. The web app consumes the fragment and connects to the paired workspace.

**Treat the pairing link like a credential.** It embeds the daemon's
bootstrap token, so anyone who has the link can pair with your daemon until
the token is rotated. Share it only with the intended recipient, and prefer
loopback (`http://127.0.0.1:...`) origins for purely local use.

For hosted (non-loopback) `webOrigin` values, the daemon must also be
configured to accept that origin via `WHITEBOARD_ALLOWED_WEB_ORIGINS` — either
as an exact match or via a `https://*.example.com` wildcard subdomain pattern
that covers it (see
[Configuration → Wildcard subdomain patterns](../reference/configuration.md#wildcard-subdomain-patterns)).
`create_pairing_link` cannot confirm that allowlist coverage on its own, so
verify it yourself before sharing a hosted pairing link. Loopback origins
need no allowlist entry.

## Silent reconnect after a reload

After pairing once via a `#wb=` link, reloading the hosted web app (or
opening it again in a fresh tab, same browser, same origin) silently
reconnects to the same daemon and reopens the canvas you were last on — no
pairing link, no confirmation prompt. If that fails for any reason, the app
falls back to the existing one-click `DaemonDetectedBanner` reconnect.

How it works:

- Right after a successful `#wb=` pairing, the web app generates a
  non-extractable ECDSA P-256 keypair with WebCrypto (the private key never
  leaves the browser's key store, not even to a bug that tries to export
  it) and persists it in IndexedDB, then calls
  `POST /api/reconnect-credential` (authenticated with the daemon token it
  just received) to enroll this origin's **public key**. The daemon persists
  the public key JWK, keyed to the exact origin that requested it, in
  `trusted-web-origins.json` under the data directory (owner-only file
  permissions, same as `daemon.json`). Only the public half ever leaves the
  browser; the daemon token itself is never persisted.
- On a later load with no `#wb=` fragment, the web app calls
  `POST /api/reconnect-challenge` (unauthenticated) to mint a one-time
  nonce for this origin, signs it with the stored private key, and calls
  `POST /api/reconnect-session` with the resulting `{ challengeId,
  signature }`. If the request's `Origin` header exactly matches the
  enrolled origin and the signature verifies against that origin's stored
  public key, the daemon responds with a fresh daemon token. While this
  request is in flight the app shows a visible "Reconnecting to local
  daemon…" status (bounded by a ~10-second timeout, never an indefinite
  hang).
- A trust record expires automatically 30 days after its last successful
  use (a sliding TTL), so an origin that stops reconnecting eventually loses
  its standing access on its own.
- **Legacy fallback.** A pre-migration daemon that does not yet understand
  the public-key contract responds to enrollment with a plaintext
  **reconnect secret** instead; the web app detects that shape, persists
  the secret in this origin's `localStorage`, and clears the just-created
  (never confirmed) keypair record. On later loads it then redeems that
  secret via `Authorization: Bearer <reconnect secret>` on
  `POST /api/reconnect-session`; a successful redemption rotates the secret
  and the app persists the replacement before using the token. This legacy
  path is capped at a 90-day absolute TTL measured from first enrollment
  (not reset by use), on top of the normal 30-day sliding TTL, so a legacy
  secret cannot stay reconnectable forever just from periodic use — it is a
  migration-compatibility shim, not the intended long-term path. The first
  successful silent redemption of a legacy secret also triggers a
  best-effort keypair enrollment attempt in the background, so a
  pre-migration browser upgrades to the public-key contract on its own
  rather than waiting out the 90-day TTL into a forced re-pairing; the
  enrollment's outcome never affects that reconnect's own result. If two tabs
  race to redeem the same legacy secret, the first to arrive wins and
  rotates it; the loser's request is rejected, and if a concurrent rotation
  is visible by then the app retries once with the winner's secret — the
  loser otherwise clears its stale secret and falls back to the banner.

This is deliberately **not** an Origin-only check: the `Origin` header is
just an HTTP header a same-machine process can set to anything, so trusting
it alone would not add anything beyond what `daemon.json`'s file permissions
already provide, and would be weaker for a request coming from anywhere the
daemon is reachable. Reconnecting requires *proving possession* of the
private key (or, on the legacy path, the rotating secret), not merely
claiming an origin.

**Threat model.** A confirmed keypair credential never leaves a signature
on the wire that could be replayed — each challenge nonce is single-use —
and the private key is non-extractable, so even a bug in the web app's own
code cannot exfiltrate it. The legacy reconnect secret, where it is still
in use, remains a long-lived *possession* credential: whoever presents it
from the enrolled origin gets back a full-authority daemon token (a scoped
OAuth grant is deliberately barred from enrolling either credential kind).
Origin binding stops a *different* origin from redeeming a credential of
either kind, but it is **not** a defense against same-origin XSS on the
paired origin — any script running there can drive WebCrypto's `sign`
operation, or read `localStorage`, the same way the app does. Treat both
credential kinds with the same care as a long-lived session cookie.

**Revoking trust.** Clicking "Forget this daemon" in the `DaemonDetectedBanner`
clears the locally stored legacy secret and reconnect target for that
browser; it does not remove an already-persisted IndexedDB keypair. Either
way, the daemon-side trust record is what actually gates a future
reconnect, so revoke it there (e.g. after a suspected compromise) with the
CLI — the daemon re-reads the trust file on each reconnect request, so
revocation takes effect immediately with no restart, regardless of which
credential kind the browser holds:

```bash
whiteboard trust list                # show trusted origins
whiteboard trust revoke <origin>    # revoke one origin
whiteboard trust revoke --all       # revoke every trusted origin
```

## Copy-first import

If you have canvases stored only in this browser (from before a daemon was
paired, or from a device that never had one) and want them on a daemon
workspace, use the browser-local canvas page's import panel:

1. Open the browser-local canvas list.
2. Select the canvases you want to move.
3. Click **Import**.

Each canvas is copied to the daemon workspace one at a time: its full Loro
history (snapshot plus any deltas) is merged into a single snapshot and
pushed as a new canvas. If two canvases would collide on the same name, the
import appends `-2`, `-3`, and so on. Import reports success or failure per
canvas.

This is deliberately **copy-first**: nothing is deleted from this browser's
IndexedDB storage during or after import. If an import fails partway
through, your original browser-local data is untouched and you can retry.

← Back to [How-to guides](README.md)
