# Development

Local-checkout setup, the HTTP MCP development loop, and how the repo's committed configs auto-override the published `npx` path.

## Prerequisites

- Node.js **24** — the major `.node-version` pins and CI installs — and `pnpm`,
  pinned by `package.json`'s `packageManager` (pnpm@11.12.0): run `corepack enable`
  before `pnpm install`, or an older global pnpm rewrites the lockfile.
  Not a recommendation: `local-node-version.test.ts` fails on any other major,
  because nine `web-jsdom` tests fail on 22 with a message about `Blob`, and
  `packages/search`'s "honours a Prepend" fails on its older ICU/Unicode table,
  and neither message names Node or the cause, so a run on the wrong major looks
  like real regressions. A root `globalSetup` prints a banner naming both on any
  project's run and never fails it. (The published package's `engines` is deliberately wider —
  that is what a CONSUMER may run the daemon on, not what this checkout builds
  on.)
- A Chromium that Playwright can drive (installed automatically below)
- ImageMagick (`convert`, `identify`) — optional locally, needed by
  `.claude/scripts/compose-figure.test.mjs` (part of `pnpm test:scripts`, and so
  of `pnpm check:local`). Without it that file's ImageMagick-dependent tests
  skip with a message naming what to install, and the rest of `pnpm check:local`
  still runs; **on CI (`CI` set) its absence fails the run**, since `ci.yml`
  installs it for exactly this file. `apt install imagemagick` or
  `brew install imagemagick` to run them locally.

```bash
git clone https://github.com/kamiazya/whiteboard.git
cd whiteboard
pnpm install
pnpm --filter @kamiazya/whiteboard-web exec playwright install --with-deps chromium
```

This installs Playwright's own Chromium, which is what a local browser-mode run uses. **CI does not**: every browser job in `.github/workflows/ci.yml` sets `WHITEBOARD_CHROME_PATH=/usr/bin/google-chrome-stable`, so CI drives the runner's system Chrome. Local and CI therefore execute browser tests in *different* browser builds — worth remembering when a browser test disagrees between them, since the browser itself is one of the variables. Set `WHITEBOARD_CHROME_PATH` locally to match CI when you are chasing exactly that kind of divergence.

A first `pnpm install` in a fresh checkout prints two `ENOENT` warnings for `dist/cli/index.js`: the `whiteboard` bin of `@kamiazya/whiteboard-mcp` points at a build output that does not exist yet. They are harmless and go away after `pnpm build`; `node .claude/scripts/new-worktree.mjs` seeds `dist` from the main checkout first, so a worktree does not print them.

## Recommended: develop against the dev daemon's `/mcp`

For active MCP development, connect Claude Code or Codex to the dev daemon's `/mcp` endpoint through the development stdio proxy rather than wiring the client to the packaged `stdio` entry directly. A `tsx watch` daemon restart does not force the MCP client to reconnect: the proxy retries each request across it.

```bash
pnpm mcp:http:dev
```

The daemon listens on an owner-only Unix socket (a named pipe on Windows) whose path it records as `socketPath` in `<dataDir>/daemon.json`, and on **no TCP port** (ADR-0050). Every development tool reaches it there: the stdio proxy, the `SessionStart` hooks (`ensure-http-dev-daemon.mjs`, `stale-issues.mjs`), each worktree's Claude Code registration, MCP Inspector (through `pnpm mcp:inspect`, which runs it on the proxy), and the web app (through the development build of the extension; see below).

> **Auto-start:** The repo's `SessionStart` hook (`packages/mcp-server/scripts/dev/ensure-http-dev-daemon.mjs`) reads the daemon record in this checkout's data dir and pings `/api/runtime/ping` over the socket it names. If nothing answers — no record, or a record a crashed daemon left behind — it spawns the daemon, and waits until the ping answers, when Claude Code or Codex opens the repo. If the daemon does not start automatically (hooks disabled, or project not yet trusted), run `pnpm mcp:http:dev` manually in a separate terminal before making MCP calls. A daemon that answers but was started with a different token than `WHITEBOARD_TOKEN` (default `whiteboard-dev`) is reported rather than reused, because it would refuse every request the proxy sends.

> **Data lives in `.dev-data/`, not your real `~/.whiteboard`:** `pnpm dev` and `pnpm mcp:http:dev` (and anything that shells out to either — `mcp:debug:http`, the `SessionStart` hook) run through `packages/mcp-server/scripts/dev/with-dev-data-dir.mjs`, which sets `WHITEBOARD_DATA_DIR` to `<repo root>/.dev-data` unless you already set it yourself. This keeps dev canvases, the SQLite metadata DB, and daemon tokens out of the real `~/.whiteboard` a packaged (npm/Docker/stdio) install uses. Launching from a `git worktree` gets that worktree's own `.dev-data` — intentional, so parallel dev-loop lanes never share (or corrupt) each other's canvas data. If you have existing dev data under `~/.whiteboard` from before this change, move its *contents* into `.dev-data` at the repo root — the `SessionStart` hook typically creates an empty `.dev-data/` before you get to this step, so a plain `mv ~/.whiteboard .dev-data` nests the old directory one level too deep (`.dev-data/.whiteboard/whiteboard.db` instead of `.dev-data/whiteboard.db`) and your canvases will look missing. From the repo root:

```bash
mkdir -p .dev-data && mv ~/.whiteboard/* ~/.whiteboard/.[!.]* .dev-data/ 2>/dev/null; rmdir ~/.whiteboard
```

Do this only while no dev daemon is running — an already-running old daemon keeps writing to `~/.whiteboard` until you restart it.

> **Per-worktree sockets:** every worktree reaches its own daemon, because the socket path is a hash of the data dir (`daemonSocketPath`) and every worktree has its own data dir. There is no port to derive, share or collide on.
>
> **The dev daemon never idles out.** `mcp:http:dev` passes `--idle-timeout-ms=0`, disabling the packaged daemon's 15-minute idle-shutdown default (`server/index.ts`'s own default, unaffected). Without this, a dev session idle past 15 minutes would silently close its own listener — the `SessionStart` hook only runs once per session, so nothing re-spawns it and the client loses its MCP tools with no error at all. Stop it explicitly with `pnpm mcp:http:stop` rather than relying on it to time out. That command acts on this checkout's data dir only: it signals the `with-dev-data-dir.mjs` wrapper recorded in `<data dir>/dev-wrapper.pid`, which forwards the stop to `tsx watch` and the daemon, then waits for the daemon to be gone. Do not stop it by matching process names — the name is the same in every checkout and worktree, so it stops other lanes' daemons too.
>
> **A second daemon for the same data dir refuses to start.** The socket path is the data dir's, so a second `pnpm mcp:http:dev` alongside the `SessionStart` hook's finds the socket answering, stops the work it had already armed, and exits with `another daemon is already listening on this socket` rather than taking the socket over. This should be rare in practice — see the spawn lock below, which closes the startup race that used to cause it.
>
> **The probe-decide-spawn sequence is mutually exclusive across processes.** Two `SessionStart` hooks starting close together (a new editor session plus a `new-worktree.mjs` run, say) used to both observe no daemon and both spawn `pnpm mcp:http:dev`, producing exactly the churn described above — and worse, a window where nothing answered the socket, which an MCP client starting during that window would see as a connection failure for its entire session (clients connect once at startup and don't retry). `ensure-http-dev-daemon.mjs` now acquires an exclusive, atomically-created lock file (`<dataDir>/dev-daemon-spawn.lock`, so it is scoped per-worktree exactly like the socket) *before* its decisive check for a daemon, and holds it until the spawned daemon is confirmed reachable or the attempt definitively fails. A hook that loses the lock does not exit or spawn a competitor — it polls for the daemon to become reachable (the same wait the winner does, bounded by `WHITEBOARD_DEV_READY_TIMEOUT_MS`) and exits 0 once it answers, since the developer's session needs a working daemon regardless of which process started it. A lock left behind by a hook that crashed before releasing it is self-healing: it is stolen once its recorded pid is no longer running, or once it exceeds `WHITEBOARD_DEV_SPAWN_LOCK_STALE_MS` (default 45s, deliberately longer than the ready-timeout default so a legitimately slow cold start is never mistaken for a crashed holder). The already-answering fast path is unaffected — it still exits without ever touching the lock file.
>
> **Claude Code auto-wiring — usually a no-op today:** `node .claude/scripts/new-worktree.mjs <name>` calls `.claude/scripts/wire-worktree-mcp.mjs` as its last step, which *attempts* to add a `--scope local` `claude mcp add` entry named `whiteboard` for the new worktree, pointed at that worktree's own stdio proxy (which reaches the worktree's own daemon over its socket). That attempt only goes through if the main checkout has no `whiteboard` entry registered yet: `~/.claude.json` keys a `--scope local` registration by the project the CLI resolves, and `claude mcp add` resolves every linked worktree of a repo to the same project — the main checkout's absolute path — so there is one `whiteboard` slot per repository, not one per worktree. Following the day-to-day setup in [CONTRIBUTING.md](../../CONTRIBUTING.md) (register the `mcp-http-stdio-proxy.mjs` stdio proxy once, at `--scope local` under the name `whiteboard`, from the main checkout) fills that slot ahead of time, so in practice every worktree's wiring attempt finds it already taken and logs a skip instead of registering anything:
>
> ```
> [wire-worktree-mcp] skipping: claude mcp add --scope local resolves a linked worktree to the
> main checkout, which already registers "whiteboard". ~/.claude.json holds one project key per
> repository, so a per-worktree registration is not something the CLI can express. This worktree's
> daemon still runs on its own data dir — register `node <worktree>/packages/mcp-server/scripts/dev/mcp-http-stdio-proxy.mjs`
> under another name if you need it.
> ```
>
> The skip is a logged branch of the script, not a hardcoded no-op — a repo whose main checkout has no `whiteboard` entry yet would see the script actually add one for the worktree. But once the main-checkout stdio-proxy registration from CONTRIBUTING.md is in place (the expected steady state), every subsequent worktree hits the skip above. Either way, the worktree's own dev daemon still starts on its own data dir regardless of Claude Code registration (see above); reach it through that worktree's proxy — the manual fallback `claude mcp add --scope local --transport stdio whiteboard -- node <worktree>/packages/mcp-server/scripts/dev/mcp-http-stdio-proxy.mjs` (swap `whiteboard` for a scratch name when the local-scope slot is already taken by the main checkout's proxy, which in steady state it is) — if you need that worktree's own isolated code and data rather than the main checkout's. The worktree setup step is non-fatal in every case: if wiring throws, exits nonzero, or hits the skip path, `new-worktree.mjs` logs it and still completes.
>
> Run it standalone against an existing worktree with `node .claude/scripts/wire-worktree-mcp.mjs <worktreePath>`, or repo-wide with `node .claude/scripts/wire-worktree-mcp.mjs --sweep` to remove `whiteboard` registrations left behind by worktrees that no longer exist — `--sweep` works whether it's run from the main checkout or from inside any linked worktree. Stale entries otherwise linger in `~/.claude.json` until you run `--sweep` after `git worktree remove`. The registration carries no token: the proxy reads `WHITEBOARD_TOKEN` from its own environment. If the `claude` CLI isn't on PATH yet, wiring is skipped with a different message instead of failing worktree setup; install `claude` and rerun `wire-worktree-mcp.mjs` (or follow CONTRIBUTING.md's stdio-proxy registration directly).

**Codex** — nothing to do: the repo-tracked `.codex/config.toml` already registers the dev stdio proxy as `whiteboard_dev` (and disables the plugin-provided published server).

**Claude Code** — register the stdio proxy once per checkout, per [CONTRIBUTING.md](../../CONTRIBUTING.md):

```bash
claude mcp add --scope local --transport stdio whiteboard -- \
  node "$(git rev-parse --show-toplevel)/packages/mcp-server/scripts/dev/mcp-http-stdio-proxy.mjs"
```

The proxy survives daemon watch restarts and never loses the session-start connection race, which is why it is preferred over registering the HTTP URL directly (see AGENTS.md's "MCP Development Mode"). Reserve the published package's own `stdio` entrypoint for packaged-distribution checks and standalone entrypoint validation. See [mcp-debugging.md](./mcp-debugging.md) for the standard debugging workflow.

## Repo-local config auto-override

Opening this repo in Codex auto-overrides the published `npx` config with the local checkout; Claude Code does so once you have run the one-time registration above. Three configs participate:

| File | Launch target | Role |
|---|---|---|
| `.mcp.json` | `npx -y @kamiazya/whiteboard-mcp@latest` | Published `stdio` config. The Codex plugin (`./.codex-plugin/plugin.json`) references it via `"mcpServers": "./.mcp.json"`, and it is bundled into the release tarball. |
| `whiteboard` at `--scope local` in `~/.claude.json` | `node ./packages/mcp-server/scripts/dev/mcp-http-stdio-proxy.mjs` | Claude Code dev override, registered once per checkout with the `claude mcp add --scope local` command above. Local scope takes precedence over `.mcp.json`'s project scope. It is machine-private, so it is not tracked here. |
| `[mcp_servers.whiteboard_dev]` in `.codex/config.toml` | the same stdio proxy | Codex repo-layer dev override. The `_dev` suffix is load-bearing: `[mcp_servers.whiteboard]` in the same file is the published entry, pinned `enabled = false` so it does not compete. Codex merges layers `system < user < cwd < tree < repo < runtime`, with later layers winning. |

The Claude plugin (`.claude-plugin/plugin.json`) carries `mcpServers` inline. Keep it in sync with `.mcp.json`. The Codex plugin (`.codex-plugin/plugin.json`) uses `./`-relative paths. Update both manifests and the actual file layout together.

### Codex trust gating (first time)

Codex disables the cwd / tree / repo layers until the project is trusted. Either approve the prompt the first time you launch `codex` in the repo, or pre-trust:

```toml
# Add to ~/.codex/config.toml
[projects."/abs/path/to/whiteboard"]
trust_level = "trusted"
```

### Same-name server conflicts

- Claude Code: the `--scope local` registration should override `.mcp.json` (precedence: local > project). `.claude/settings.json` is not an option — its schema has no `mcpServers` field, and a definition placed there is silently ignored. Verify with `/mcp` if you change this.
- Codex: confirmed in source that `mcp_servers` is fully overwritten by later layers ([codex-rs/config/src/merge.rs](https://github.com/openai/codex/blob/main/codex-rs/config/src/merge.rs)).

If behavior diverges, fall back to renaming `.mcp.json` to `.mcp.json.published` and updating the Codex plugin path.

## When MCP server restart is required

`WHITEBOARD_ROOT` and `DIST_WEB_APP_DIR` in `packages/mcp-server/src/server/config.ts` resolve once at startup, relative to `import.meta.url`. After any of the following, restart the Claude Code session or run `/mcp reconnect`:

- Moving the source tree to a different path (e.g. into a different monorepo)
- Changing the `dist/web-app` build location
- Editing `config.ts` itself

This does not affect normal published usage through `npx -y @kamiazya/whiteboard-mcp@latest`, because each launch is a fresh spawn.

## The browser extension and its native host (ADR-0050)

The hosted app reaches the local daemon only through a browser extension; the
daemon listens on no loopback port (ADR-0050, closing-loopback stage done
2026-09-28). The web app in development reaches the dev daemon the same way,
through the development build of the extension, which also admits
`localhost`.

- `apps/extension` is a Manifest V3 extension that relays each page connection
  to one native messaging host process. `pnpm --filter @kamiazya/whiteboard-extension build`
  writes `dist/production` (admits the hosted app only) and `dist/development`
  (also `localhost` and `127.0.0.1`, for a dev server). Load either with
  **Load unpacked** on `chrome://extensions`; the manifest carries a key, so the
  id is always `ckgipndlpblkhiplhnbbdnpnibflplje`.
- The build also writes `dist/firefox-production` and `dist/firefox-development`.
  Firefox lets no page message an extension, so that build relays through a
  content script on the admitted pages instead, and its id is
  `whiteboard@kamiazya.github.io`. Load it with **Load Temporary Add-on** on
  `about:debugging` (pick its `manifest.json`); it lasts until Firefox restarts.
- `whiteboard native-host install --json [--data-dir=<path>] [--manifest-dir=<path>] [--firefox-manifest-dir=<path>]`
  registers the host with each browser this user has run (Chrome, Chromium,
  Edge, Brave and Firefox, Ubuntu's snap Firefox included) on Linux and macOS,
  and on Windows with Chrome, Chromium, Edge and Firefox through a per-user
  registry key naming a manifest kept under the data dir (the daemon's socket
  there is a named pipe). It writes a launcher under the data dir and, per
  browser, a manifest that lets
  only the extension above start it — Chromium's naming the extension's origin,
  Firefox's its id, since Firefox refuses a manifest that carries both. The snap
  Firefox asks once, through a desktop dialog, before it first starts the host,
  and remembers the answer — a refusal too; the user guide says how to clear
  it. One host name
  means one data dir per browser: installing for `.dev-data` replaces the
  registration for `~/.whiteboard`.
- The host relays only `/api/` requests, to the owner-only socket the daemon
  records in `daemon.json`, and attaches the daemon's token itself — the page
  never holds one.
- In the web app, **Connect through the extension** is offered wherever the
  app says no daemon is connected, once the extension answers: Settings >
  Connections, an empty browser workspace's first screen, and a browser-kept
  document's workspace popover. The daemon is
  remembered under the reserved address `https://daemon.whiteboard.invalid`,
  which nothing on a network answers: `createDaemonFetch` sends every request
  to that address through the extension, whatever fetch a caller passes, the
  session syncs over SSE (the bridge carries no WebSocket), and the SSE stream
  is the page's own rather than the SharedWorker's, since a worker cannot reach
  an extension. A later visit reconnects by pinging the daemon through the
  extension, with no pairing grant to renew.
- `pnpm --filter @kamiazya/whiteboard-extension smoke:bridge` proves the whole
  path in headless Chromium against a real daemon, including the built web app
  connecting, reading an agent's note, writing back, and seeing the agent's
  next edit arrive live. Branded Chrome ignores `--load-extension`, so it needs
  `pnpm exec playwright install chromium` once.
- `smoke:bridge:firefox` proves the same in Firefox, over WebDriver: Playwright
  cannot load an extension into Firefox. It needs geckodriver and a Firefox that
  is not the snap (whose portal dialog wants a person), named by `GECKODRIVER`
  and `FIREFOX_BIN` or found on `PATH`. Mozilla's own Linux tarball and a
  geckodriver release both work unpacked anywhere.

## Cloudflare Pages header parity in local dev

`apps/web/public/_headers` (security headers, CSP) is only served by
Cloudflare Pages, so a policy mistake there used to be invisible until the
deployed origin broke (the missing `frame-src` shipped exactly this way).
Two layers close that gap:

- **Every `vite` dev/preview response** carries the `_headers` global block
  via `apps/web/vite-dev-headers.ts`. The one dev-only amendment is
  `script-src … 'unsafe-inline'` (the react-refresh preamble is inline);
  everything else — including what the CSP blocks — matches production. A
  CSP violation during normal dogfooding is therefore a real production
  bug, not dev noise.
- **Byte-exact Pages behavior** (path-scoped blocks, redirects):
  `pnpm --filter @kamiazya/whiteboard-web preview:pages` builds and serves
  `dist/` through `wrangler pages dev`.

## Test commands

```bash
pnpm dev             # Vite + the dev daemon together (both on .dev-data, this worktree's socket)
pnpm mcp             # MCP server only (tsx)
pnpm build           # dist/server (apps/web's `build` ends with `copy-into-mcp-dist.mjs`, which copies dist/web-app in)
pnpm build:mcp       # the server alone: canvas-viewer's widget first, then `@kamiazya/whiteboard-mcp`'s build (a `pnpm --filter` build does not build its workspace dependencies, so the bare filter form fails on a clean checkout with "widget build output not found")
pnpm test            # optional: every Vitest project at once; CI runs the matrix
pnpm typecheck       # tsc --noEmit
pnpm smoke           # MCP smoke
pnpm smoke:e2e       # version / route / no_client wiring smoke
pnpm smoke:claude    # Claude subprocess smoke (uses API quota)
pnpm smoke:codex     # Codex subprocess smoke (uses API quota)
pnpm eval:tool-surface # LLM-driven tool-surface eval on a seeded fixture (uses API quota; ADR-0031)
```

`packages/canvas-viewer`'s self-contained widget bundle (`dist/widget/canvas-viewer.html` — all JS/CSS/fonts inlined, zero external requests) is regenerated with:

```bash
pnpm --filter @kamiazya/whiteboard-canvas-viewer build:widget
```

Default local pass after a change. CI runs the full matrix on every push, so a local full run is the same work twice; run the area you touched, then the gates:

```bash
pnpm test --project <area>   # the nearest project(s) for what you touched; CONTRIBUTING.md's table names them
pnpm typecheck               # tsc --noEmit in every workspace package that defines a typecheck script (mcp-server also checks its test files, which its build config excludes: tsconfig.test.json)
pnpm smoke:e2e               # stdio MCP subprocess: wb_workspace_edit -> wb_canvas_edit -> version save/list/restore -> document.set -> wb_document_get
pnpm check:local             # every gate CI's check job runs
pnpm test:browser            # when the change touches real-browser behavior
pnpm test                    # optional: every project at once, not required; full suite (see root vitest.config.ts): mcp-node, mcp-smoke, daemon-client node, model node, ports node, facet-engine node, facet-ui jsdom, plugin-visual node/jsdom, codec node, loro-adapter node, search node, reference-graph node, server-core node, workspace-index node, history node, scene node, extension node, arch-lint-node, canvas-render node/browser, canvas-viewer node/jsdom/browser, apps/web node/jsdom/browser/browser-window-state (Playwright projects are slower)
```

For a fast, narrow pass while iterating on `packages/mcp-server` (selects only the `mcp-node` project out of the twenty-eight configured in root `vitest.config.ts`; the table in [CONTRIBUTING.md](../../CONTRIBUTING.md) lists what each project covers, so everything it does not cover is not run):

```bash
pnpm test --project mcp-node
```

If you also need a zero-context LLM-level check:

```bash
pnpm smoke:claude   # spawn the claude CLI; verifies tools are callable via description / schema (uses API quota)
pnpm smoke:all      # smoke:e2e + smoke:claude
```

The project-scoped skill `.claude/skills/whiteboard-mcp-smoke/SKILL.md` encodes this workflow — restart triage, which smoke to run in what order, and how to read a failure — so a "verify behavior" request can trigger it without restarting manually.

## Shared-channel hygiene

Three rules for anything that spawns a child process, writes to a shared stream, or reads ambient configuration — release scripts, smoke harnesses, `tools/checks/*`, and CI workflow steps alike:

- **Pass child-process env explicitly, never rely on ambient job/step env.** A GitHub Actions job-level `env:` is inherited by every step in that job, not just the one that needs it — this silently widens the blast radius of a variable like `WHITEBOARD_DEV` (which switches the daemon spawn between `tsx`-from-source and the built `dist/`) to steps that never asked for it. Scope environment variables to the step (or the specific subprocess call) that actually consumes them.
- **stdout is a data channel, not a log.** Anything that pipes a subprocess's stdout for parsing (`npm pack --dry-run --json`, MCP stdio framing, etc.) breaks the moment unrelated diagnostic output lands on the same stream. Server code logs through `getLogger` (stderr); CLI scripts that produce a machine-readable result write diagnostics to stderr and reserve stdout for the result.
- **Configuration is read at the point of use, not frozen into a module constant at import time.** A constant computed once from `process.env` at module load survives past the point where the surrounding process legitimately changes that environment (e.g. a test stubbing it, or a long-lived watch process), and the drift is invisible until something depends on the frozen value. Read `process.env` (or an injected equivalent) where the decision is actually made.
