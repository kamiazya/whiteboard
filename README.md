# @kamiazya/whiteboard

> A collaborative Excalidraw canvas for Claude Code and Codex. Draw with your AI agent to align on specs, architecture, workflows, and explanations — directly on a shared real-time whiteboard.

[![npm version](https://img.shields.io/npm/v/@kamiazya/whiteboard-mcp.svg)](https://www.npmjs.com/package/@kamiazya/whiteboard-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/kamiazya/whiteboard/actions/workflows/ci.yml/badge.svg)](https://github.com/kamiazya/whiteboard/actions/workflows/ci.yml)

`@kamiazya/whiteboard-mcp` runs a live Excalidraw canvas in your browser and exposes MCP tools so Claude Code, Codex, or any MCP-capable agent can draw, annotate, and refine diagrams alongside you. Canvases live locally under `~/.whiteboard/`, sync over WebSocket, and round-trip with stock `.excalidraw` JSON.

## Table of Contents

- [Why Whiteboard](#why-whiteboard)
- [Try It](#try-it)
- [Install](#install)
  - [Server-only install (`npx`)](#server-only-install-npx)
  - [Full install with shared skills](#full-install-with-shared-skills)
  - [Link the shared skills](#link-the-shared-skills)
- [Bundled Skills](#bundled-skills)
- [Main MCP Tools](#main-mcp-tools)
- [Architecture & Internals](#architecture-and-internals)
- [Developer Setup](#developer-setup)
- [Environment Variables](#environment-variables)
- [Verification Pattern](#verification-pattern)
- [Limitations & Known Caveats](#limitations--known-caveats)
- [Release / Publish](#release--publish)
- [License](#license)

---

## Why Whiteboard

- 🖊️ **Two-way drawing surface** — your agent places, moves, and groups elements while you keep editing in the same browser tab.
- 🎯 **Real Excalidraw, not a screenshot** — JSON round-trip with `.excalidraw` files; open in [excalidraw.com](https://excalidraw.com) or the desktop app any time.
- 🔒 **Local-first** — all canvases, snapshots, and exports stay under `~/.whiteboard/{workspaceId}/`. No cloud account required.
- 📦 **Skills bundled in the package** — three opinionated `SKILL.md` packs (`whiteboard`, `whiteboard-coauthoring`, `whiteboard-audit`) so the agent already knows when and how to use the tool.
- 🧷 **Checkpoint & restore** — branch a canvas before risky edits and roll back from snapshot.
- 🖼️ **PNG + JSON export** — `export_png` returns the image straight back to the LLM as MCP `ImageContent`; `canvas_export_json` produces standard `.excalidraw` files for round-tripping.

---

## Try It

After installing, ask your agent things like:

- *"Use whiteboard to sketch the request flow for our auth service: client → API gateway → token service → DB."*
- *"Create a comparison diagram on the whiteboard: monolith vs microservices, side by side."*
- *"Open the existing `auth-flow` workspace and add a fallback path for when the token service is down."*
- *"Insert the `service-fragment` template at (0, 0) with `service=API`, `store=Postgres`, then export PNG."*
- *"Audit my whiteboard workspaces — find orphaned ones and tombstone-heavy canvases I can clean up."*

The bundled `/whiteboard` skill triggers when text descriptions feel ambiguous; `/whiteboard-coauthoring` adds a structured back-and-forth loop for evolving diagrams together; `/whiteboard-audit` reports cleanup candidates across `~/.whiteboard/`.

---

## Install

Choose one install track:

- **Server-only**: start the MCP server quickly with `npx`
- **Full install with shared skills**: install the npm package locally, then link the bundled skills into Claude Code or Codex

The only public release artifact today is the npm package `@kamiazya/whiteboard-mcp`. The committed `.claude-plugin/`, `.codex-plugin/`, and `.mcp.json` files are repo-local wrappers and examples, not separately published release artifacts.

### Server-only install (`npx`)

```json
"whiteboard": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@kamiazya/whiteboard-mcp@latest"]
}
```

The `npx` path starts the MCP server only. It does not install `/whiteboard` skills.

Server-only smoke check:

- Confirm `canvas_create({slug: "smoke"})` succeeds
- Confirm it creates `~/.whiteboard/{workspaceId}/`

### Full install with shared skills

```bash
mkdir -p ~/tools/whiteboard && cd ~/tools/whiteboard
npm init -y
npm i @kamiazya/whiteboard-mcp
```

If you prefer a pinned package instead of `@latest`, replace the version in the `npx` examples below and keep the shared skills in a local npm install:

**Claude Code**: add this to `mcpServers` in `~/.claude.json`:

```json
"whiteboard": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@kamiazya/whiteboard-mcp@latest"],
  "description": "Collaborative Excalidraw-based diagramming",
  "env": {}
}
```

**Codex**: add this to `~/.codex/config.toml`:

```toml
[mcp_servers.whiteboard]
command = "npx"
args = ["-y", "@kamiazya/whiteboard-mcp@latest"]
```

### Link the shared skills

The canonical shared-skill path is:

```text
node_modules/@kamiazya/whiteboard-mcp/skills
```

#### Mac / Linux

```bash
PKG=$(pwd)/node_modules/@kamiazya/whiteboard-mcp
mkdir -p ~/.claude/skills ~/.codex/skills
ln -s "$PKG/skills/whiteboard"                  ~/.claude/skills/whiteboard
ln -s "$PKG/skills/whiteboard-coauthoring"      ~/.claude/skills/whiteboard-coauthoring
ln -s "$PKG/skills/whiteboard-audit"            ~/.claude/skills/whiteboard-audit
ln -s "$PKG/skills/whiteboard"                  ~/.codex/skills/whiteboard
ln -s "$PKG/skills/whiteboard-coauthoring"      ~/.codex/skills/whiteboard-coauthoring
ln -s "$PKG/skills/whiteboard-audit"            ~/.codex/skills/whiteboard-audit
```

#### Windows (junction or copy)

Use junctions if your shell has permission to create them:

```powershell
$pkg = (Resolve-Path .\node_modules\@kamiazya\whiteboard-mcp).Path
$skillRoots = @(
    (Join-Path $HOME ".claude\skills"),
    (Join-Path $HOME ".codex\skills")
)
$skills = "whiteboard", "whiteboard-coauthoring", "whiteboard-audit"

$skillRoots | ForEach-Object { New-Item -ItemType Directory -Force $_ | Out-Null }

foreach ($root in $skillRoots) {
    foreach ($skill in $skills) {
        $linkPath = Join-Path $root $skill
        $targetPath = Join-Path $pkg "skills\$skill"
        cmd /c mklink /J "$linkPath" "$targetPath"
    }
}
```

If junction creation is restricted, copy the skill directories instead of linking them.

Even when you use the Codex plugin or Claude Code plugin, the bundled `skills/` inside `@kamiazya/whiteboard-mcp` remain the source of truth for shared skills.

### Bundled Skills

The npm package ships three Skills under `node_modules/@kamiazya/whiteboard-mcp/skills/`. After symlinking them into `~/.claude/skills/` and `~/.codex/skills/` (see above), the slash skills become available to the agent.

| Skill | When to use |
|---|---|
| `whiteboard` | When screen layout, structure, flow, or comparison still feels too ambiguous in text alone — start drawing on the canvas together. |
| `whiteboard-coauthoring` | A structured loop for evolving diagrams with the agent: gather context, structure frame by frame, run fresh-viewer tests on what you draw. |
| `whiteboard-audit` | Audit existing workspaces — detect orphaned workspaces, tombstone-heavy canvases, and cache/disk mismatches; report cleanup candidates. |

The `SKILL.md` of each pack is the source of truth. The repo-local `.claude/skills/` directory contains internal-only project skills (smoke selection, restart triage) that are not part of the published artifact.

### Restart and smoke check

- Restart Claude Code or Codex
- Confirm `/whiteboard` and `/whiteboard-coauthoring` appear in the skill list
- Confirm `canvas_create({slug: "smoke"})` succeeds and creates `~/.whiteboard/{workspaceId}/`

---

## Developer Setup

```bash
git clone https://github.com/kamiazya/whiteboard.git
cd whiteboard
pnpm install
```

### Recommended: develop over HTTP MCP

During MCP development, connecting to the daemon-hosted `/mcp` endpoint over HTTP is cheaper to restart than wiring the client directly to `stdio`. Even if `tsx watch` restarts the daemon, Codex and Claude Code can keep pointing at the same `http://127.0.0.1:3099/mcp`.

```bash
pnpm mcp:http:dev
```

**Codex**:

```toml
[mcp_servers.whiteboard]
url = "http://127.0.0.1:3099/mcp"
```

**Claude Code**:

```bash
claude mcp add --transport http whiteboard http://127.0.0.1:3099/mcp --scope local
```

Prefer this setup for normal development. Reserve `stdio` for packaged-distribution checks and standalone entrypoint validation.

### Run browser tests

Browser tests use Playwright-managed Chromium by default. CI and the release workflow use the same assumption and run:

```bash
pnpm exec playwright install --with-deps chromium
```

Only set `WHITEBOARD_CHROME_PATH` if you specifically want to use a local system Chrome:

```bash
WHITEBOARD_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  pnpm test:browser
```

#### Separate published config from repo-local development config

This repo includes multiple MCP configs at the repo root and under `.claude/` and `.codex/`. The design is that opening this repo in Claude Code or Codex immediately auto-overrides the published config with the local checkout dev server.

| File | Launch target | Role | Scope |
|---|---|---|---|
| `.mcp.json` | `npx -y @kamiazya/whiteboard-mcp@latest` | Published `stdio` config. The Codex plugin (`./.codex-plugin/plugin.json`) references it via `"mcpServers": "./.mcp.json"`, and it is bundled into the release tarball | shared |
| `mcpServers.whiteboard` in `.claude/settings.json` | `node ./packages/mcp-server/scripts/mcp-dev-launch.mjs` (`WHITEBOARD_DEV=1`) | Claude Code-only dev override. Project scope (`.claude/settings.json`) takes precedence over `.mcp.json` ([scope precedence](https://code.claude.com/docs/en/configuration.md)) | shared (committed) |
| `[mcp_servers.whiteboard]` in `.codex/config.toml` | same as above | Codex-only dev override. Codex merges config layers in the order `system < user < cwd < tree (./.codex/config.toml) < repo (<git-root>/.codex/config.toml) < runtime`, with later layers winning ([codex/docs/config.md](https://github.com/openai/codex/blob/main/docs/config.md)) | shared (committed) |

**The Claude plugin (`./.claude-plugin/plugin.json`) carries `mcpServers` inline inside the plugin manifest.** Its contents should match the published `.mcp.json` version (`npx @latest`). If you change one, keep both `.mcp.json` and `.claude-plugin/plugin.json` in sync.

**The Codex plugin (`./.codex-plugin/plugin.json`) uses `./`-relative paths for `skills` and `mcpServers`.** That matches the Codex plugin build pattern where paths are resolved relative to the plugin root. If you move paths, update both `.codex-plugin/plugin.json` and the actual file layout together.

If you want to try the repo-local checkout:

- **Claude Code**: no extra action needed. `.claude/settings.json` auto-overrides.
- **Codex**: `.codex/config.toml` auto-overrides, but the repo must be trusted the first time.
- **Codex (HTTP helper mode)**: run `pnpm mcp:http:dev` in another terminal and switch Codex to `url = "http://127.0.0.1:3099/mcp"` so only the daemon restarts, not the `stdio` session.

##### Codex trust gating (first-time setup)

Codex disables cwd / tree / repo layers unless either `~/.codex/config.toml` contains `[projects.<abs_path>] trust_level = "trusted"` or you approve the trust prompt in the Codex TUI. A fresh clone starts as untrusted, so approve it one of these ways:

```toml
# Add to ~/.codex/config.toml
[projects."/abs/path/to/excalidraw-tool"]
trust_level = "trusted"
```

Or answer `yes` to the prompt the first time you launch `codex`. After that, the repo’s `.codex/config.toml` loads automatically and you do not need to swap configs manually.

##### Same-name server conflicts

- Claude Code: based on documented scope precedence (Project > User), `.claude/settings.json` should override `.mcp.json`. Because the official docs do not spell out conflict resolution in detail, verify behavior with `/mcp` if you are changing this.
- Codex: confirmed in source that `mcp_servers: HashMap<String, McpServerConfig>` is fully overwritten by later layers ([codex-rs/config/src/merge.rs](https://github.com/openai/codex/blob/main/codex-rs/config/src/merge.rs)).

If behavior diverges, one fallback is to rename `.mcp.json` to something like `.mcp.json.published` and update the Codex plugin path to match.

See [docs/mcp-debugging.md](docs/mcp-debugging.md) for the standard MCP debugging workflow.

The MCP config points at the cwd-independent wrapper `packages/mcp-server/scripts/mcp-dev-launch.mjs`:

```json
"whiteboard": {
  "type": "stdio",
  "command": "node",
  "args": ["/Users/<user>/ghq/github.com/kamiazya/whiteboard/packages/mcp-server/scripts/mcp-dev-launch.mjs"],
  "env": {}
}
```

If you also want the daemon to track the source tree, add `WHITEBOARD_DEV=1` to `env`:

```json
"whiteboard": {
  "type": "stdio",
  "command": "node",
  "args": ["/Users/<user>/ghq/github.com/kamiazya/whiteboard/packages/mcp-server/scripts/mcp-dev-launch.mjs"],
  "env": { "WHITEBOARD_DEV": "1" }
}
```

Use the same skill symlink steps in a developer setup, replacing the package path with your local checkout path.

### When MCP server restart is required

`WHITEBOARD_ROOT` and `DIST_APP_DIR` in `packages/mcp-server/src/server/config.ts` are resolved only once at startup, relative to `import.meta.url`. If you do any of the following, restart the Claude Code session or run `/mcp reconnect` so the MCP server is spawned again:

- Move the source tree to a different path, such as into a monorepo
- Change the build output location for `dist/app`
- Edit the config file itself (`config.ts`)

This does not affect normal published usage through `npx -y @kamiazya/whiteboard-mcp@latest`, because each launch is a fresh spawn. It only matters in local-checkout development mode.

### Codex sandbox constraints

Inside the Codex sandbox, these two issues are common:

- Writing to `~/.whiteboard` may fail.
  If no env override is set, the app automatically falls back to a temp directory.
- Listening on `127.0.0.1:<port>` may be blocked.
  In that case daemon startup fails with `Failed to bind daemon port ... (EPERM ...)`. Run in an environment that allows loopback listening or adjust the sandbox configuration.

---

## Main Commands

```bash
pnpm dev             # Start Vite and the MCP server together for development
pnpm mcp             # Start the MCP server only (tsx)
pnpm build           # Build dist/server and dist/app
pnpm test            # Run Vitest
pnpm typecheck       # Run tsc --noEmit
pnpm smoke           # MCP smoke test
pnpm smoke:e2e       # checkpoint / route / no_client wiring smoke
pnpm smoke:template  # template tool smoke
pnpm smoke:claude    # Claude subprocess smoke (uses quota)
pnpm smoke:codex     # Codex subprocess smoke (uses quota)
pnpm intent:validate # TanStack Intent validate
```

---

## Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `WHITEBOARD_DATA_DIR` | Runtime data directory | `~/.whiteboard` (automatically falls back into `tmp` if unwritable) |
| `WHITEBOARD_MCP_AUTHORIZATION_SERVER(S)` | Authorization Server URL included in MCP Protected Resource Metadata, as preparation for remote OAuth 2.1 support | unset |
| `WHITEBOARD_MCP_RESOURCE` | Canonical MCP resource URL to expose in metadata. If unset, `/mcp` is derived from the incoming request URL | unset |
| `WHITEBOARD_MCP_SCOPES_SUPPORTED` | Comma-separated list of scopes to expose in metadata | unset |

If `WHITEBOARD_DATA_DIR` is unset, the app uses `~/.whiteboard`.

---

## Architecture And Internals

See also:

- [docs/architecture.md](docs/architecture.md)
- [docs/security-model.md](docs/security-model.md)
- [docs/wire-protocol.md](docs/wire-protocol.md)

> An architecture diagram (`docs/architecture.png` / `docs/architecture.excalidraw`) is planned and will be drawn using the tool itself. For now, the structure is described in text.

**Components:**
- **MCP Client**: Claude Code, Codex, or another client calling tools over `stdio` JSON-RPC.
- **MCP Server**: the main entrypoint (`dist/server/mcp/index.js`). It speaks `stdio` to the client and launches Hono as a child process.
- **Hono HTTP/WebSocket**: REST APIs for canvas data and WS broadcasting. `export_png` and `viewport_set` send instructions to the browser over WS and settle on ACK.
- **Browser tab**: React + Excalidraw. It emits local LoroDoc updates over WS and applies remote imports incrementally.
- **Storage**: under `~/.whiteboard/{workspaceId}/`, storing Loro snapshots (`.loro`), exports (`.png`, `.excalidraw`), and checkpoints (`.checkpoints/{id}.loro`).

### Main MCP Tools

| Tool | Purpose |
|---|---|
| `canvas_create` / `canvas_list` / `canvas_inspect` / `canvas_open` | Canvas lifecycle. `canvas_open` supports `fullscreen: true` to hide the sidebar |
| `template_list` / `template_insert` | List and insert built-in template fragments. `template_insert` expands through `annotate_batch`, so inserted elements remain normally editable |
| `annotate` / `annotate_batch` | Add elements, either single-shot or batched with grid layout |
| `update_element` / `delete_element` / `move_elements` / `canvas_clear` | Edit elements |
| `viewport_set` | Control browser pan and zoom (`mode: "fit"` / `"move"`) |
| `export_png` | Export PNG. On success it also returns `imageBase64` as MCP `ImageContent` to the LLM |
| `canvas_export_json` | Export in standard `.excalidraw` JSON format for round-tripping with Excalidraw desktop or excalidraw.com |
| `checkpoint_save` / `checkpoint_restore` | Save and restore state from snapshots under `.checkpoints/` |
| `load_image` | Import an external image into the canvas |

### Template Fragment JSON Format

`template_insert` can load either a built-in `templateId` or an external JSON file. It is not Excalidraw native-library compatible. Instead it uses a lightweight template format that reuses `annotate_batch` recipes.

```json
{
  "format": "excalidraw-tool-template",
  "version": 1,
  "id": "service-fragment",
  "title": "Service Fragment",
  "description": "Reusable architecture part",
  "variables": [
    { "name": "service", "default": "API" },
    { "name": "store", "default": "DB" }
  ],
  "annotations": [
    {
      "type": "box_with_label",
      "name": "service",
      "target": { "x": 0, "y": 40 },
      "width": 180,
      "height": 84,
      "text": "{{service}}"
    },
    {
      "type": "box_with_label",
      "name": "store",
      "target": { "x": 260, "y": 40 },
      "width": 180,
      "height": 84,
      "text": "{{store}}"
    },
    {
      "type": "arrow",
      "startBoxName": "service",
      "endBoxName": "store",
      "label": "read/write"
    }
  ]
}
```

**Constraints and behavior:**

- Each annotation omits `coords`, which means the default `absolute` mode. Template coordinates are treated as offsets from the insertion `target`. `relative` and `parent` are reserved for future support.
- `group.memberIds` refer to real element IDs on an existing canvas, so writing them into a template is meaningless. They are not interpolation or scaling targets.
- `{{variable}}` placeholders expand inside string fields such as `text`, `subText`, `title`, `label`, `name`, `startBoxName`, and `endBoxName`. That means binding names themselves can be parameterized, such as `name: "{{id}}-box"`, which works well with the binding-name DSL for multiple instances.
- Undeclared variables passed through `variables` are still expanded instead of ignored. Silent use of undeclared variables is allowed, and typos are not detected.
- `scale` applies to `target`, `endTarget`, `width`, `height`, `padding`, `labelOffset`, and `layout.cellW,cellH,gap,origin`. It does not apply to `row` or `col`, which are grid indexes.

---

## Verification Pattern

Regression detection after changes follows three layers:

```bash
pnpm test        # unit tests (< 3s, 460+ tests)
pnpm typecheck   # tsc --noEmit (< 10s)
pnpm smoke:e2e   # launch MCP stdio subprocess and verify canvas_create -> checkpoint -> viewport/export no_client -> canvas_export_json round trip (< 10s, no API quota)
```

If you also need a zero-context LLM-level check:

```bash
pnpm smoke:claude   # launch claude CLI as a subprocess and verify tools are callable via description/schema (uses API quota)
pnpm smoke:all      # smoke:e2e + smoke:claude
```

The project-scoped skills `.claude/skills/whiteboard-mcp-smoke/SKILL.md` (restart triage) and `.claude/skills/whiteboard-smoke/SKILL.md` (smoke selection) already encode this workflow so a simple “verify behavior” request can trigger it without restarting manually.

---

## Limitations & Known Caveats

Be aware of these constraints before adopting whiteboard:

- **Browser tab required for live edits and PNG export** — `viewport_set` and the live drawing surface need a Chromium tab connected over WebSocket. `export_png` runs through Playwright-managed Chromium (or the system Chrome named by `WHITEBOARD_CHROME_PATH`).
- **`stdio` is the published transport** — the public release artifact is `npx -y @kamiazya/whiteboard-mcp@latest` over `stdio`. The HTTP MCP endpoint (`pnpm mcp:http:dev`) is for local development only.
- **`npx` install does not install skills** — the `npx` path starts the MCP server only. To get `/whiteboard`, `/whiteboard-coauthoring`, and `/whiteboard-audit`, follow the [full install with shared skills](#full-install-with-shared-skills) and link them into `~/.claude/skills/` or `~/.codex/skills/`.
- **No published Claude Code plugin marketplace yet** — the committed `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` are repo-local wrappers, not separately published release artifacts. `/plugin marketplace add` flows are not supported until a `marketplace.json` lands.
- **Codex sandbox quirks** — inside the Codex sandbox, writing to `~/.whiteboard` may fail (the app falls back to a temp directory) and binding `127.0.0.1:<port>` may be denied with `EPERM`. Run in an environment that allows loopback listening or adjust the sandbox.
- **Template format is whiteboard-specific** — `template_insert` does not load Excalidraw native libraries; it expands a lightweight `excalidraw-tool-template` JSON through `annotate_batch`. See [Template Fragment JSON Format](#template-fragment-json-format).
- **Local checkout config caching** — `WHITEBOARD_ROOT` and `DIST_APP_DIR` resolve once at startup. Moving the source tree, changing the `dist/app` build location, or editing `config.ts` requires `/mcp reconnect` or a Claude Code / Codex restart.

---

## Release / Publish

Releases are automated with **release-please**. Manual `npm publish` should normally not be needed.

### Workflow

1. Push to `main` using [Conventional Commits](https://www.conventionalcommits.org/)
   - `feat: ...` -> minor bump
   - `fix: ...` -> patch bump
   - `feat!:` or a `BREAKING CHANGE:` footer -> major bump
   - `chore:` / `docs:` / `refactor:` / `test:` -> no version bump, though still listed in the changelog
2. The GitHub Actions `release` workflow automatically creates or updates a `chore(main): release X.Y.Z` PR containing the `package.json` version bump and changelog updates
3. A maintainer reviews and merges that PR
4. The workflow runs again from the merge with `release_created=true` and performs:
   - `pnpm install --frozen-lockfile`
   - `pnpm test` / `pnpm typecheck` / `pnpm smoke:e2e`
   - `pnpm build` -> `npm publish`
   - GitHub Release + tag creation

### Local checks before merging a release PR

```bash
pnpm test
pnpm typecheck
pnpm smoke:e2e
npm pack --dry-run   # verify the tarball includes dist/, skills/, package README, and LICENSE
```

### Config Files

- [`release-please-config.json`](release-please-config.json): release type and tag format
- [`.release-please-manifest.json`](.release-please-manifest.json): current version source of truth
- [`.github/workflows/release.yml`](.github/workflows/release.yml): workflow implementation

---

## License

MIT
