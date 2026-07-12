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

The daemon listens on `http://127.0.0.1:3099/mcp`.

> **Auto-start:** The repo's `SessionStart` hook (`packages/mcp-server/scripts/dev/ensure-http-dev-daemon.mjs`) probes port 3099 and spawns the daemon automatically when Claude Code or Codex opens the repo. If the daemon does not start automatically (hooks disabled, project not yet trusted, or port 3099 already in use by another process), run `pnpm mcp:http:dev` manually in a separate terminal before making MCP calls.

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

Default regression triple after a change:

```bash
pnpm test        # unit tests (~3s, 460+ tests)
pnpm typecheck   # tsc --noEmit (~10s)
pnpm smoke:e2e   # stdio MCP subprocess: canvas_create -> version save/restore -> viewport / export no_client -> canvas_export_json round trip
```

If you also need a zero-context LLM-level check:

```bash
pnpm smoke:claude   # spawn the claude CLI; verifies tools are callable via description / schema (uses API quota)
pnpm smoke:all      # smoke:e2e + smoke:claude
```

The project-scoped skills `.claude/skills/whiteboard-mcp-smoke/SKILL.md` (restart triage) and `.claude/skills/whiteboard-smoke/SKILL.md` (smoke selection) encode this workflow so a "verify behavior" request can trigger it without restarting manually.
