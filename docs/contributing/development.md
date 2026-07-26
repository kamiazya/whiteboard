# Development

Local-checkout setup, the HTTP MCP development loop, and how the repo's committed configs auto-override the published `npx` path.

## Prerequisites

- Node.js 22+ (24 recommended — matches `.node-version`) and `pnpm`
- A Chromium that Playwright can drive (installed automatically below)

```bash
git clone https://github.com/kamiazya/whiteboard.git
cd whiteboard
pnpm install
pnpm exec playwright install --with-deps chromium
```

CI and the release workflow assume Playwright-managed Chromium. Set `WHITEBOARD_CHROME_PATH` only when you specifically want to drive a system Chrome.

## Bundled skills install

The MCP server ships three slash skills (`drawing-visuals`, `coauthoring-visuals`, `auditing-workspaces`) inside the npm package, but the `claude mcp add` / `npx` install paths only start the server. To make the skills available to the agent, install the package locally and symlink (or copy) them.

```bash
mkdir -p ~/tools/whiteboard && cd ~/tools/whiteboard
npm init -y
npm i @kamiazya/whiteboard-mcp
```

### macOS / Linux

```bash
PKG=$(pwd)/node_modules/@kamiazya/whiteboard-mcp
mkdir -p ~/.claude/skills ~/.codex/skills
ln -s "$PKG/skills/drawing-visuals"        ~/.claude/skills/drawing-visuals
ln -s "$PKG/skills/coauthoring-visuals"    ~/.claude/skills/coauthoring-visuals
ln -s "$PKG/skills/auditing-workspaces"    ~/.claude/skills/auditing-workspaces
ln -s "$PKG/skills/drawing-visuals"        ~/.codex/skills/drawing-visuals
ln -s "$PKG/skills/coauthoring-visuals"    ~/.codex/skills/coauthoring-visuals
ln -s "$PKG/skills/auditing-workspaces"    ~/.codex/skills/auditing-workspaces
```

### Windows (junction or copy)

```powershell
$pkg = (Resolve-Path .\node_modules\@kamiazya\whiteboard-mcp).Path
$skillRoots = @(
    (Join-Path $HOME ".claude\skills"),
    (Join-Path $HOME ".codex\skills")
)
$skills = "drawing-visuals", "coauthoring-visuals", "auditing-workspaces"
$skillRoots | ForEach-Object { New-Item -ItemType Directory -Force $_ | Out-Null }
foreach ($root in $skillRoots) {
    foreach ($skill in $skills) {
        cmd /c mklink /J (Join-Path $root $skill) (Join-Path $pkg "skills\$skill")
    }
}
```

If junctions are restricted, copy the skill directories instead. Restart Claude Code or Codex, then confirm `/drawing-visuals`, `/coauthoring-visuals`, and `/auditing-workspaces` appear in the skill list.

The bundled `skills/` inside `@kamiazya/whiteboard-mcp` remain the source of truth; the repo-local `.claude/skills/` directory contains internal-only project skills (smoke selection, restart triage) that are not part of the published artifact.

## Recommended: develop over HTTP MCP

For active MCP development, connect Claude Code or Codex to the daemon-hosted `/mcp` endpoint over HTTP rather than wiring the client to `stdio` directly. A `tsx watch` daemon restart does not force the MCP client to reconnect.

```bash
pnpm mcp:http:dev
```

The daemon listens on `http://127.0.0.1:3099/mcp` from the main checkout.

> **Auto-start:** The repo's `SessionStart` hook (`packages/mcp-server/scripts/dev/ensure-http-dev-daemon.mjs`) probes this checkout's derived dev port and spawns the daemon automatically when Claude Code or Codex opens the repo. If the daemon does not start automatically (hooks disabled, project not yet trusted, or the port already in use by another process), run `pnpm mcp:http:dev` manually in a separate terminal before making MCP calls.

> **Data lives in `.dev-data/`, not your real `~/.whiteboard`:** `pnpm mcp:http:dev` (and anything that shells out to it — `mcp:debug:http`, the `SessionStart` hook) runs through `packages/mcp-server/scripts/dev/with-dev-data-dir.mjs`, which sets `WHITEBOARD_DATA_DIR` to `<repo root>/.dev-data` unless you already set it yourself. This keeps dev canvases, the SQLite metadata DB, and daemon tokens out of the real `~/.whiteboard` a packaged (npm/Docker/stdio) install uses. Launching from a `git worktree` gets that worktree's own `.dev-data` — intentional, so parallel dev-loop lanes never share (or corrupt) each other's canvas data. If you have existing dev data under `~/.whiteboard` from before this change, move its *contents* into `.dev-data` at the repo root — the `SessionStart` hook typically creates an empty `.dev-data/` before you get to this step, so a plain `mv ~/.whiteboard .dev-data` nests the old directory one level too deep (`.dev-data/.whiteboard/whiteboard.db` instead of `.dev-data/whiteboard.db`) and your canvases will look missing. From the repo root:

```bash
mkdir -p .dev-data && mv ~/.whiteboard/* ~/.whiteboard/.[!.]* .dev-data/ 2>/dev/null; rmdir ~/.whiteboard
```

Do this only while no dev daemon is running — an already-running old daemon on `:3099` keeps writing to `~/.whiteboard` until you restart it.

> **Per-worktree ports:** every worktree gets its own dev daemon port, not just its own data dir. `packages/mcp-server/scripts/dev/dev-port-lib.mjs` is the single place this is derived, and both `with-dev-data-dir.mjs` (the spawn wrapper) and `ensure-http-dev-daemon.mjs` (the probe/spawn hook) import it — they can never disagree about which port a given worktree belongs on. The rule: the **main checkout always gets 3099** (back-compat with every doc, hook, and packaged script written before per-worktree ports existed); every **linked worktree** gets a deterministic port in `[3100, 3999]` derived by hashing its absolute repo root path. Run `node .claude/scripts/new-worktree.mjs <name>` to see a new worktree's port in its summary output, or compute it directly:
>
> ```bash
> node -e "import('./packages/mcp-server/scripts/dev/dev-port-lib.mjs').then(({deriveDevPort, isMainCheckout}) => { const repoRoot = process.cwd(); console.log(deriveDevPort({ repoRoot, isMainCheckout: isMainCheckout(repoRoot), env: process.env })) })"
> ```
>
> Set `WHITEBOARD_DEV_PORT` in the shell to override the derived port for a checkout (useful if two worktrees happen to hash-collide, or you just want a fixed value).
>
> `with-dev-data-dir.mjs` also writes a small identity marker to `<dataDir>/dev-daemon.json` (`{ port, repoRoot, pid, startedAt }`) when it spawns the daemon, and removes it on clean exit. `ensure-http-dev-daemon.mjs` reads this marker back after a healthy authenticated `/mcp` probe: a daemon that answers with the right bearer token but has no marker (or a mismatched port) for this worktree is treated as a **foreign daemon** — most likely a different worktree that happened to hash-collide on the same port, since the default dev token (`whiteboard-dev`) is shared across every checkout. The hook fails loudly in that case rather than silently reusing the wrong worktree's daemon and data; the error message names both the expected port and the expected data dir so you know which `WHITEBOARD_DEV_PORT` override (or `pkill -f mcp:http:dev`) to reach for.
>
> This closes the gap left when `.dev-data/` isolation first shipped: before per-worktree ports, every worktree probed the same fixed `:3099`, so opening a second worktree would silently attach to the first worktree's daemon (its code, its data) instead of starting its own.
>
> **Claude Code auto-wiring:** `node .claude/scripts/new-worktree.mjs <name>` calls `.claude/scripts/wire-worktree-mcp.mjs` as its last step, which registers a `--scope local` `claude mcp add` entry named `whiteboard` pointed at the new worktree's derived port. A `--scope local` entry lives in `~/.claude.json`, keyed by that worktree's absolute path, and cleanly shadows the repo-tracked `.mcp.json` project-scope `whiteboard` entry of the same name — opening the worktree in Claude Code resolves `whiteboard` to the right daemon with no manual step and no second, confusingly-named MCP entry to choose between (a `--scope local` entry under the same name shadows the project-scope `.mcp.json` entry — verified against the real CLI). It is idempotent (a matching existing registration is a no-op) and non-destructive (a conflicting existing registration — e.g. pointed at a different port, or any registration shape this script doesn't fully recognize, classifies as a conflict by design — is reported, never overwritten; resolve it with `claude mcp remove whiteboard -s local` and rerun). The worktree setup step is also non-fatal: if wiring throws or exits nonzero, `new-worktree.mjs` prints a warning and still completes.
>
> Run it standalone against an existing worktree with `node .claude/scripts/wire-worktree-mcp.mjs <worktreePath>`, or repo-wide with `node .claude/scripts/wire-worktree-mcp.mjs --sweep` to remove `whiteboard` registrations left behind by worktrees that no longer exist — `--sweep` works whether it's run from the main checkout or from inside any linked worktree. Stale entries otherwise linger in `~/.claude.json` until you run `--sweep` after `git worktree remove`. If you change `WHITEBOARD_TOKEN`, existing registrations still carry the old token; `claude mcp remove whiteboard -s local` and rerun the wiring to pick up the new one. If the `claude` CLI isn't on PATH yet, wiring is skipped with a message instead of failing worktree setup — wire manually afterward with `claude mcp add --transport http whiteboard http://127.0.0.1:<port>/mcp --scope local --header 'Authorization: Bearer whiteboard-dev'` (or a Codex `-c mcp_servers.whiteboard.url=...` override; Codex auto-wiring is a separate follow-up).

**Codex** — set in `~/.codex/config.toml`:

```toml
[mcp_servers.whiteboard]
url = "http://127.0.0.1:3099/mcp"
```

**Claude Code**:

```bash
claude mcp add --transport http whiteboard http://127.0.0.1:3099/mcp --scope local
```

Reserve `stdio` for packaged-distribution checks and standalone entrypoint validation. See [mcp-debugging.md](./mcp-debugging.md) for the standard debugging workflow.

## Repo-local config auto-override

Opening this repo in Claude Code or Codex auto-overrides the published `npx` config with the local checkout. Three configs participate:

| File | Launch target | Role |
|---|---|---|
| `.mcp.json` | `npx -y @kamiazya/whiteboard-mcp@latest` | Published `stdio` config. The Codex plugin (`./.codex-plugin/plugin.json`) references it via `"mcpServers": "./.mcp.json"`, and it is bundled into the release tarball. |
| `mcpServers.whiteboard` in `.claude/settings.json` | `node ./packages/mcp-server/scripts/dev/mcp-dev-launch.mjs` (`WHITEBOARD_DEV=1`) | Claude Code project-scope dev override. Project scope takes precedence over `.mcp.json`. |
| `[mcp_servers.whiteboard]` in `.codex/config.toml` | same as above | Codex repo-layer dev override. Codex merges layers `system < user < cwd < tree < repo < runtime`, with later layers winning. |

The Claude plugin (`.claude-plugin/plugin.json`) carries `mcpServers` inline. Keep it in sync with `.mcp.json`. The Codex plugin (`.codex-plugin/plugin.json`) uses `./`-relative paths. Update both manifests and the actual file layout together.

### Codex trust gating (first time)

Codex disables the cwd / tree / repo layers until the project is trusted. Either approve the prompt the first time you launch `codex` in the repo, or pre-trust:

```toml
# Add to ~/.codex/config.toml
[projects."/abs/path/to/whiteboard"]
trust_level = "trusted"
```

### Same-name server conflicts

- Claude Code: project-scope `.claude/settings.json` should override `.mcp.json`. Verify with `/mcp` if you change this.
- Codex: confirmed in source that `mcp_servers` is fully overwritten by later layers ([codex-rs/config/src/merge.rs](https://github.com/openai/codex/blob/main/codex-rs/config/src/merge.rs)).

If behavior diverges, fall back to renaming `.mcp.json` to `.mcp.json.published` and updating the Codex plugin path.

## When MCP server restart is required

`WHITEBOARD_ROOT` and `DIST_WEB_APP_DIR` in `packages/mcp-server/src/server/config.ts` resolve once at startup, relative to `import.meta.url`. After any of the following, restart the Claude Code session or run `/mcp reconnect`:

- Moving the source tree to a different path (e.g. into a different monorepo)
- Changing the `dist/web-app` build location
- Editing `config.ts` itself

This does not affect normal published usage through `npx -y @kamiazya/whiteboard-mcp@latest`, because each launch is a fresh spawn.

## Test commands

```bash
pnpm dev             # Vite + MCP server together
pnpm mcp             # MCP server only (tsx)
pnpm build           # dist/server (apps/web build copies dist/web-app in via its postbuild step)
pnpm test            # Vitest (all projects)
pnpm typecheck       # tsc --noEmit
pnpm smoke           # MCP smoke
pnpm smoke:e2e       # version / route / no_client wiring smoke
pnpm smoke:template  # template tool smoke
pnpm smoke:claude    # Claude subprocess smoke (uses API quota)
pnpm smoke:codex     # Codex subprocess smoke (uses API quota)
pnpm intent:validate # TanStack Intent validate
```

`packages/canvas-viewer`'s self-contained widget bundle (`dist/widget/canvas-viewer.html` — all JS/CSS/fonts inlined, zero external requests) is regenerated with:

```bash
pnpm --filter @kamiazya/whiteboard-canvas-viewer build:widget
```

Default regression triple after a change:

```bash
pnpm test        # full suite (see root vitest.config.ts): mcp-node, mcp-smoke, canvas-model node, canvas-ports node, canvas-render node/browser, canvas-viewer node/jsdom/browser, apps/web node/jsdom/browser (Playwright projects are slower)
pnpm typecheck   # tsc --noEmit (~10s)
pnpm smoke:e2e   # stdio MCP subprocess: canvas_create -> version save/restore -> viewport no_client -> export_canvas (png/svg/json)
```

For a fast, narrow pass while iterating on `packages/mcp-server` (selects only the `mcp-node` project out of the thirteen configured in root `vitest.config.ts`, so it also skips `mcp-smoke`, canvas-model node, canvas-ports node, canvas-render node/browser, canvas-viewer node/jsdom, apps/web node/jsdom, and all three browser projects — not just the Playwright browser project):

```bash
pnpm test --project mcp-node
```

If you also need a zero-context LLM-level check:

```bash
pnpm smoke:claude   # spawn the claude CLI; verifies tools are callable via description / schema (uses API quota)
pnpm smoke:all      # smoke:e2e + smoke:claude
```

The project-scoped skills `.claude/skills/whiteboard-mcp-smoke/SKILL.md` (restart triage) and `.claude/skills/whiteboard-smoke/SKILL.md` (smoke selection) encode this workflow so a "verify behavior" request can trigger it without restarting manually.

## Shared-channel hygiene

Three rules for anything that spawns a child process, writes to a shared stream, or reads ambient configuration — release scripts, smoke harnesses, `tools/checks/*`, and CI workflow steps alike:

- **Pass child-process env explicitly, never rely on ambient job/step env.** A GitHub Actions job-level `env:` is inherited by every step in that job, not just the one that needs it — this silently widens the blast radius of a variable like `WHITEBOARD_DEV` (which switches the daemon spawn between `tsx`-from-source and the built `dist/`) to steps that never asked for it. Scope environment variables to the step (or the specific subprocess call) that actually consumes them.
- **stdout is a data channel, not a log.** Anything that pipes a subprocess's stdout for parsing (`npm pack --dry-run --json`, MCP stdio framing, etc.) breaks the moment unrelated diagnostic output lands on the same stream. Server code logs through `getLogger` (stderr); CLI scripts that produce a machine-readable result write diagnostics to stderr and reserve stdout for the result.
- **Configuration is read at the point of use, not frozen into a module constant at import time.** A constant computed once from `process.env` at module load survives past the point where the surrounding process legitimately changes that environment (e.g. a test stubbing it, or a long-lived watch process), and the drift is invisible until something depends on the frozen value. Read `process.env` (or an injected equivalent) where the decision is actually made.
