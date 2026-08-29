# Configuration

Runtime environment variables and sandbox quirks.

## Environment variables

**An unset setting takes its default; a setting that is present but cannot be
understood aborts startup.** Setting a value is how you state a requirement,
so falling back to a default would answer that requirement with behaviour you
did not ask for and tell you nowhere. A blank or whitespace value counts as
unset, not as a mistake — with one documented exception: for
`WHITEBOARD_ALLOWED_WEB_ORIGINS` an empty string is a deliberate opt-out that
restores loopback-only admission, so there it means something rather than
nothing. Every offending variable is named in one startup
failure, so a single restart is enough to fix them all — and the message names
variables only, never their values, since a database URL can carry a
credential.

This applies to the storage and durability settings
(`WHITEBOARD_FILE_GC_INTERVAL_MS`, `WHITEBOARD_FILE_GC_GRACE_MS`,
`WHITEBOARD_WORKSPACE_TAIL_MS`, `WHITEBOARD_DATABASE_URL`), to
`WHITEBOARD_LOG_LEVEL`, to `WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS` (which fails
the `ensureDaemon` call rather than a server boot, since that is the moment it
is read), and to `WHITEBOARD_ALLOWED_WEB_ORIGINS` and
`WHITEBOARD_OAUTH_CLIENT_REGISTRY`, which already behaved this way.

`0` is not a blanket "off": it disables the two GC sweeps, because that is how
you stop one without removing the variable, but it is an error for
`WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS`, where it would mean "give up before
looking".

The `1`-or-off flags (`WHITEBOARD_DEBUG`, `WHITEBOARD_DEV`,
`WHITEBOARD_NO_WATCH`) are deliberately outside the rule: they are on only for
exactly `1`, so `true` and `yes` are off rather than errors. That is kept on
purpose — a spec you can hold in your head beats a forgiving one that has to
enumerate which spellings of true it accepts.

| Variable | Purpose | Default |
|---|---|---|
| `WHITEBOARD_DATA_DIR` | Runtime data directory. Workspaces, snapshots, versions, and exports all live underneath it. | `~/.whiteboard` (falls back to the OS temp directory if unwritable) |
| `WHITEBOARD_CHROME_PATH` | Override the Chromium binary used for browser automation and doc-snapshot regeneration. No current MCP tool depends on this binary — `wb_scene_render` and the OKF/JSON Canvas export tools are all rendered headlessly. | unset (Playwright-managed Chromium) |
| `WHITEBOARD_DEV` | When set to `1`, the dev-launch wrapper enables source-tree watching so a `tsx watch` change restarts the daemon in place. | unset |
| `WHITEBOARD_MCP_AUTHORIZATION_SERVER(S)` | Authorization Server URL exposed in MCP Protected Resource Metadata, in preparation for remote OAuth 2.1. | unset |
| `WHITEBOARD_MCP_RESOURCE` | Canonical MCP resource URL exposed in metadata. If unset, `/mcp` is derived from the incoming request URL. | unset |
| `WHITEBOARD_MCP_SCOPES_SUPPORTED` | Comma-separated list of scopes exposed in metadata. | unset |
| `WHITEBOARD_LOG_LEVEL` | Minimum severity the server emits, using the RFC 5424 names (`debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`). `warn` is accepted for `warning`, matching the wider Node ecosystem, and the value is case-insensitive with surrounding whitespace trimmed. Any other value **aborts startup**: it used to become `warning` silently, so an operator who set `debug` to investigate an incident got no debug output and no reason. `MCP_HTTP_DEBUG=1` lowers this to `info` on its own. Clients can also adjust their own view at runtime via MCP `logging/setLevel`. | `warning` |
| `WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS` | How long `ensureDaemon` waits for a freshly spawned daemon to answer. Packaged cold start (native modules, WASM, first-run migrations) can exceed the default on slow CI runners. Must be a bare positive base-10 integer; a present value that is anything else — including `0`, which would mean "give up before looking" — **throws** instead of falling back, since whoever set it had a slow environment in mind and silently waiting the default would deliver the very failure they were avoiding. An explicit caller-supplied option always wins. | `10000` (10s) |
| `MCP_HTTP_DEBUG` | When set to `1`, the HTTP MCP server logs `[mcp-http:init]` / `[mcp-http]` events to help diagnose request flow. | unset |
| `WHITEBOARD_ALLOWED_WEB_ORIGINS` | Comma-separated list of extra hosted origins admitted alongside the fixed loopback set (`localhost`, `127.0.0.1`, `::1`) on `/api/*` CORS, `/mcp`, and WS upgrade — **local-daemon mode only**. Each entry must be an exact `https://` origin (no path/query/fragment/credentials) **or** a `https://*.example.com` wildcard subdomain pattern (see below); bare `*` is rejected. Matching is case-insensitive on the host and normalizes the default `:443` port, but any other port is significant. An invalid entry aborts daemon startup with a logged error naming the offending entry's index (the raw value is never echoed). Can also be set via a [config file](#config-file-local-daemon)'s `allowedWebOrigins` key; this env var always wins. Setting the variable — even to an empty string — replaces the default below entirely; the empty string is the explicit opt-out that restores loopback-only admission. | `https://kamiazya-whiteboard.pages.dev` (the official hosted web app) |
| `WHITEBOARD_FILE_GC_INTERVAL_MS` | How often the background file-GC sweeper runs `purgeDanglingFiles` across every workspace (DB-registered plus upload-only workspaces found on disk). Must be a bare non-negative base-10 integer string (`/^\d+$/`); a present value that is anything else (`1.5`, `1x`, negative, scientific notation, or beyond `Number.MAX_SAFE_INTEGER`) **aborts startup** rather than silently becoming the default; blank counts as unset. Surrounding whitespace is trimmed, since it is a transport artifact of compose files and shell quoting rather than an intent. Accepted values above `2147483647` (the `setTimeout` maximum, ~24.8 days) are clamped down to that maximum. `0` disables the periodic sweep entirely — dangling files then accumulate until purged manually via the purge route. | `86400000` (24h) |
| `WHITEBOARD_FILE_GC_GRACE_MS` | Minimum age (by file mtime) an unreferenced upload must reach before a purge pass — manual or via the periodic sweeper — deletes it. Protects the window between an upload finishing and the matching `saveCanvas` call landing. Must be a bare non-negative base-10 integer string (`/^\d+$/`), the same strictness as `WHITEBOARD_FILE_GC_INTERVAL_MS` above; a present value that is anything else **aborts startup**. It was parsed leniently with `Number.parseInt` until 2026-08-29, which read `1h` as **1 millisecond** and `30m` as 30 — collapsing the very window this setting exists to hold open, so a freshly-written upload was deleted before the save referencing it landed. | `3600000` (1h) |
| `WHITEBOARD_WORKSPACE_TAIL_MS` | How often this daemon follows the stored record for each workspace that has a connected client, so a browser attached to THIS instance receives what ANOTHER instance wrote. **Off unless set** — a single daemon already learns about its own writes and would be polling for nothing. Set it only when more than one daemon serves one data directory. Must be a bare positive base-10 integer string. `0` and a blank value mean off — `0` is how you stop following without removing the variable — while anything else (`2s`, `1.5`, `-1`, `1e3`) **aborts startup**, so a mistyped value neither becomes an unintended interval nor silently disables following you asked for. Propagation is eventual by design ([ADR-0020](../contributing/adr/0020-coordination-boundary.md)): a client that misses a round converges on the next one, so this is a latency dial rather than a correctness one. | unset (off) |
| `WHITEBOARD_DATABASE_URL` | Where this instance's rows live. Unset means the file in the data directory, which is what a single daemon has always used. More than one instance cannot share that file — SQLite's locking does not survive a network filesystem, and two machines cannot share a local one at all — so point every instance at one libSQL server instead (`libsql://…`, `https://…`, or `http://…` for a loopback sqld in development). A value that is not a URL, or uses another scheme, or uses `http:` for a non-loopback host, **aborts startup**: falling back to the local file would give each instance its own database, diverging with no error anywhere. Blobs and version thumbnails still live in the data directory and are content-addressed, so a shared volume serves them. Setting this makes `whiteboard server backup` and `whiteboard server restore` refuse: they copy the data directory, which no longer holds the rows. Those commands also refuse a directory with no `whiteboard.db` in it regardless of this variable, since they run host-side where a container's env-file is not loaded. | unset (the data directory's `whiteboard.db`) |
| `WHITEBOARD_DATABASE_AUTH_TOKEN` | Bearer token for `WHITEBOARD_DATABASE_URL` when the server requires one (Turso, an authenticated sqld). Ignored for a `file:` database. Empty or whitespace is treated as unset rather than sent as an empty credential. | unset |

## Auto-opening the browser (`whiteboard daemon run`)

`whiteboard daemon run` opens your default browser at the daemon's own
origin (`http://127.0.0.1:<port>`) once it is listening — no pairing link
needed, since the daemon injects the token server-side into the HTML it
serves (see [Connect to a local daemon](../how-to/connect-to-local-daemon.md)).

This only happens when ALL of the following hold; any one failing suppresses
it silently (logged at `debug`, never printed to stdout/stderr):

- you did not pass `--no-open` or set `openBrowser: false` in a
  [config file](#config-file-local-daemon),
- stdout is an interactive TTY (so scripts, CI runners, and piped output never
  trigger it),
- `CI` is not set in the environment,
- the process is not running inside a container (Docker, Podman, …),
- the daemon is bound to a loopback host (`127.0.0.1` / `localhost` / `::1` —
  the only hosts `whiteboard daemon run` accepts in the first place).

Honored on the `whiteboard daemon run` CLI path only — `server/index.ts` (the
dev-watch entrypoint behind `pnpm mcp:http:dev`) and `whiteboard server run`
(server-mode) never call this, so repeated `tsx watch` restarts during local
development do not spawn a new tab per restart, and a server-mode deployment
never pops a browser on its host.

Setting `WHITEBOARD_ALLOWED_WEB_ORIGINS` only widens which browser *origins*
the daemon will talk to over CORS/WS — it does not change authentication.
Mutating `/api/*` routes still require the daemon Bearer token, and `/mcp`
still requires its own auth regardless of origin. Only add an origin you
control; the hosted pairing flow this enables also depends on the browser's
own Local Network Access permission prompt (Chrome), which is a separate,
per-user consent step.

### Wildcard subdomain patterns

Both `WHITEBOARD_ALLOWED_WEB_ORIGINS` and `WHITEBOARD_SERVER_ALLOWED_ORIGINS`
accept a `https://*.example.com`-shaped entry alongside exact origins. This is
meant for deployment-preview shapes such as Cloudflare Pages branch previews
(`https://*.your-project.pages.dev`), where every branch gets its own
subdomain and listing each one explicitly is impractical.

Rules:

- The wildcard `*` must be the **entire leftmost label** and nothing else —
  `https://*.example.com` is valid; `https://foo*.example.com`,
  `https://*.*.example.com`, and bare `*` are all rejected.
- Only **one label** is matched: `https://preview.example.com` matches
  `https://*.example.com`, but `https://a.b.example.com` does not.
- The pattern must be `https://` — wildcards are never accepted for
  loopback `http://` origins.
- The static suffix after the wildcard must retain at least two labels
  (`example.com`, not `.dev` or `.com` alone). This is a structural check,
  not a public-suffix-list lookup — **`https://*.pages.dev` passes it but
  admits every Cloudflare Pages project**, not just yours. Always scope the
  pattern to your own project label, e.g.
  `https://*.your-project.pages.dev`.

## Config file (local daemon)

As an alternative to exporting env vars by hand, the local daemon (`whiteboard
daemon run`, and the `server/index.ts` HTTP entrypoint) auto-loads a config
file. Only the current working directory is searched — ancestor directories
are deliberately NOT walked up, so a config file planted in a parent
directory (e.g. the root of an untrusted cloned repo) can never inject a
token or widen the CORS allowlist. The first match wins, searched in this
order in the current directory:

1. `.whiteboardrc`
2. `.whiteboardrc.json`
3. `.whiteboardrc.yaml`
4. `.whiteboardrc.yml`
5. `.whiteboard/config.yaml`
6. `.whiteboard/config.yml`
7. `whiteboard.config.json`
8. `package.json` (`"whiteboard"` field)

If nothing is found in the current directory, `~/.whiteboard/config.yaml`
is consulted as a per-machine fallback. Only declarative JSON/YAML/rc formats
are supported — `whiteboard.config.js` and similar JS loaders are deliberately
NOT searched, so a config file can never execute code at daemon startup.

Example `.whiteboard/config.yaml`:

```yaml
allowedWebOrigins:
  - https://kamiazya-whiteboard.pages.dev
port: 3123
logLevel: info
```

Supported keys: `allowedWebOrigins` (string array), `port` (1-65535),
`token`, `logLevel` (`debug` / `info` / `notice` / `warning` / `error` /
`critical` / `alert` / `emergency`), `dataDir`, and `openBrowser` (boolean;
see [Auto-opening the browser](#auto-opening-the-browser-whiteboard-daemon-run)).
Unknown keys are logged as a warning and dropped rather than silently
ignored; an invalid value (wrong type, out-of-range port, etc.) aborts
startup with an error naming the file path and the offending key.

**Precedence: environment variable > config file > built-in default.** Any
`WHITEBOARD_*` env var that is already set always wins over the same value
in a config file. The daemon logs which config file it loaded (path only,
never the token value) at startup.

Two scoped exceptions worth knowing:

- **`port`**: a config-file port behaves exactly like an explicit `--port` —
  the daemon does not auto-scan for another free port if that one is busy,
  it fails hard and names the port and the config file. Auto-scan from 3099
  only happens when neither `--port` nor a config-file port is set.
- **`dataDir`**: honored on the `whiteboard daemon run` CLI path only. The
  `server/index.ts` HTTP entrypoint resolves its data directory at module
  import time, before a config file can be loaded, so a `dataDir` key there
  produces a startup warning instead of silently doing nothing — use
  `WHITEBOARD_DATA_DIR` on that entrypoint instead.
- **`openBrowser`**: also honored on the `whiteboard daemon run` CLI path
  only, for the same reason `dataDir` is scoped there — see
  [Auto-opening the browser](#auto-opening-the-browser-whiteboard-daemon-run).
  An explicit `--no-open` flag always wins over this key.

**Security note:** a `token` value in a config file is a dev-only
convenience — treat it like a `.env` file with a secret in it (do not commit
it, restrict its file permissions). Prefer `WHITEBOARD_TOKEN` /
`WHITEBOARD_DAEMON_TOKEN` for anything beyond local development.

## Codex sandbox constraints

Inside the Codex sandbox, two issues are common:

- **Writing to `~/.whiteboard` may fail.** Without an env override, the app automatically falls back to a temp directory.
- **Listening on `127.0.0.1:<port>` may be blocked.** Daemon startup fails with `Failed to bind daemon port ... (EPERM ...)`. Run in an environment that allows loopback listening or adjust the sandbox configuration.

## Storage layout

Each workspace lives at `${WHITEBOARD_DATA_DIR}/{workspaceId}/` and contains:

- `*.loro` — Loro CRDT snapshots (one per canvas)
- `*.svg`, `*.md` (OKF), `*.canvas` (JSON Canvas) — exports (via `wb_scene_render` / `wb_document_get`)
- `palette.json`, `manifestJson`, library metadata, and other persisted JSON

See [architecture](../explanation/architecture.md) for how each layer reads and writes this tree.
