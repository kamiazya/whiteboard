# Connect the web app to a local daemon

The web app (`apps/web`) can run entirely in the browser with no daemon —
canvases are stored in IndexedDB and never leave the device. This guide
covers what happens once a local daemon (started via `whiteboard mcp` or an
MCP client) is also running on the same machine, and how to move a
canvas kept in your browser onto it.

The web app UI calls these "variations" and "combining changes," but the
underlying MCP tools your AI agent calls (`create_branch`, `merge`, and so
on) intentionally keep their git-derived names — the UI vocabulary is a
presentation-layer choice and does not change the tool contract.

## The daemon serves only the pairing page

The local daemon is a backend: the one page it serves is `/pair`, the
pairing consent page (which must come from the daemon's own origin — it is
the trust anchor that pins the daemon's identity key). Opening
`http://127.0.0.1:<port>/` (default port `3099`) in a browser redirects to
the official hosted app, which connects back to the daemon through its
default origin admission and a pairing grant.

Running `whiteboard daemon run` interactively opens the hosted app in your
default browser automatically once the daemon is listening. Pass `--no-open`
(or set `openBrowser: false` in a
[config file](../reference/configuration.md#config-file-local-daemon))
to disable this. See
[Auto-opening the browser](../reference/configuration.md#auto-opening-the-browser-whiteboard-daemon-run)
for the full list of conditions under which it is suppressed (CI, containers,
non-interactive shells, non-loopback binds).

Note the tradeoff this design accepts: with no network access and no
previously-installed PWA, there is no canvas UI on a first run — install the
hosted app as a PWA while online to keep an offline-capable editor.

## How detection works

The web app probes `GET /api/runtime/ping` on the daemon's default loopback
origin (`http://127.0.0.1:3099`, or a custom `daemonBaseUrl` from your
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
  link to this page.

This is determined by probing the daemon, not by inspecting your browser's
identity string: the app only shows the "not supported" notice once a probe
has actually proven the browser blocked the request.

**On an unsupported browser, daemon connectivity is currently unavailable.**
The daemon no longer serves a full UI at its own origin (it serves only the
`/pair` consent page), so the previous escape hatch — opening
`http://127.0.0.1:3099` directly — no longer applies. Use a Chromium-based
browser (Chrome, Edge, Brave, Arc) to connect the hosted app to a local
daemon; on other engines the hosted app keeps working with browser
storage only.

## How pairing works

Detecting a daemon is not the same as pairing with it. Actually connecting
the web app's canvas editor to a specific workspace requires a pairing link,
which the web app cannot mint itself — it can only detect that *a* daemon is
reachable and prompt you toward the pairing flow below.

## Connect from the hosted app (pairing grant)

The hosted web app can pair itself — no agent required:

1. In the hosted app, use "Check for local daemon" and click **Use here**
   (or **connect anyway** from the failure notice when the daemon has not
   allowed this origin yet — the consent navigation is not subject to the
   CORS block that hides the daemon from the check).
2. The browser navigates to the daemon's own `/pair` consent page, which
   shows the requesting origin. Click **Approve**.
3. The daemon persists an origin grant, allowlists the origin on every
   surface immediately, and sends the browser back with a single-use
   PKCE-bound code (never a token). The hosted app exchanges it for a
   24-hour, origin-scoped session token and opens the daemon's workspaces
   in place.

Grants persist across daemon restarts; session tokens do not (a restart is
a deliberate global session kill). Approving is always an explicit click on
the daemon's own page — there is no silent grant path.

## Connect with an agent-minted link

1. Ask your AI agent (Claude, Codex, or any MCP client connected to the
   whiteboard daemon) to call the `create_pairing_link` MCP tool. Optionally
   pass `workspaceId` / `path` to target a specific canvas, or `webOrigin` to
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

The hosted app's "Check for local daemon" does not assume the default
port: it re-checks daemons it has successfully found before (remembered in
the browser, most recent first) and scans a small range above the default
(3099–3108) in parallel, because the daemon binds the first free port from
3099 upward. When several daemons respond — one per dev worktree is
common — the banner lists each of them.

For hosted (non-loopback) `webOrigin` values other than the official web app
(`https://kamiazya-whiteboard.pages.dev`, admitted by default), the daemon
must also be configured to accept that origin via
`WHITEBOARD_ALLOWED_WEB_ORIGINS` — either
as an exact match or via a `https://*.example.com` wildcard subdomain pattern
that covers it (see
[Configuration → Wildcard subdomain patterns](../reference/configuration.md#wildcard-subdomain-patterns)).
`create_pairing_link` cannot confirm that allowlist coverage on its own, so
verify it yourself before sharing a hosted pairing link. Loopback origins
need no allowlist entry.

## Pairing is required every session

Earlier versions of the web app offered a "silent reconnect" that skipped
re-pairing on a reload by minting a possession credential (a WebCrypto
keypair, with a plaintext-secret fallback for older daemons) and storing it
in the browser origin's own IndexedDB/localStorage. That feature has been
**removed**.

The reason is loopback-port squatting: on `http://localhost:<port>`, any
process that later takes over that port inherits the full origin, including
everything IndexedDB and localStorage hold for it — Vite's dev port (5173)
in particular is one of the most commonly contended ports on a developer
machine. A same-origin script does not need to exfiltrate a non-extractable
key to abuse it; it can read the `CryptoKey` object straight out of
IndexedDB and call `crypto.subtle.sign()` with it, and a plaintext secret in
`localStorage` is even more directly readable. Removing the credential
entirely, rather than trying to hedge it, means this version of the app
never creates or uses one again.

Credentials written by an earlier version are a separate matter. The app
erases them the first time it boots on that origin: the `reconnectKeypairs`
object store is dropped during the IndexedDB upgrade, and the legacy
localStorage secret is removed at startup regardless of whether the database
is opened. Until that boot happens the old values are still sitting in the
origin's storage, so a process that claims the port and serves the origin
first can still read them. If you have an origin you no longer open with
this app — an abandoned dev port, for instance — clear its site data in the
browser rather than relying on a startup path that will never run.

The cost: reloading the hosted web app, or opening it in a fresh tab, no
longer reconnects automatically. Each session re-pairs via a fresh `#wb=`
link (or the one-click `DaemonDetectedBanner` reconnect below, which is a
plain top-level navigation to the daemon's own origin — not a stored
credential). See the [security model](../explanation/security-model.md) for
the full trust-boundary discussion, including why this does not extend to
canvas *data* itself when the browser is the keeper.

A daemon upgraded from a version that had silent reconnect may still hold
origin trust records from that era in `trusted-web-origins.json`. The daemon
now removes that file automatically on its first start after the upgrade —
no operator action is needed, and no CLI command exists to inspect or revoke
individual entries any more. If you are auditing the data directory after an
upgrade and the file is gone, this is why.

## Copy-first import

If you have canvases stored only in this browser (from before a daemon was
paired, or from a device that never had one) and want them on a daemon
workspace, use the import panel on the canvas page kept in your browser:

1. Open the canvas list kept in your browser.
2. Select the canvases you want to move.
3. Click **Import**.

Each canvas is copied to the daemon workspace one at a time: its full Loro
history (snapshot plus any deltas) is merged into a single snapshot and
pushed as a new canvas. If two canvases would collide on the same name, the
import appends `-2`, `-3`, and so on. Import reports success or failure per
canvas.

This is deliberately **copy-first**: nothing is deleted from this browser's
IndexedDB storage during or after import. If an import fails partway
through, your original data in the browser is untouched and you can retry.

← Back to [How-to guides](README.md)
