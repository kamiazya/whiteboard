# Connect the web app to a local daemon

The web app (`apps/web`) can run entirely in the browser with no daemon —
canvases are stored in IndexedDB and never leave the device. This guide
covers what happens once a local daemon (started via `whiteboard mcp` or an
MCP client) is also running on the same machine, and how to move a
browser-local canvas onto it.

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
  explicit notice instead of a silently missing "connect" option.

This is determined by probing the daemon, not by inspecting your browser's
identity string: the app only shows the "not supported" notice once a probe
has actually proven the browser blocked the request.

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
