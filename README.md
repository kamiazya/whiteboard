# @kamiazya/whiteboard

> A collaborative Excalidraw canvas for Claude Code and Codex. Draw with your AI agent to align on specs, architecture, and workflows — directly on a shared real-time whiteboard.

[![npm version](https://img.shields.io/npm/v/@kamiazya/whiteboard-mcp.svg)](https://www.npmjs.com/package/@kamiazya/whiteboard-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/kamiazya/whiteboard/actions/workflows/ci.yml/badge.svg)](https://github.com/kamiazya/whiteboard/actions/workflows/ci.yml)

`@kamiazya/whiteboard-mcp` runs a live Excalidraw canvas in your browser and exposes MCP tools so Claude Code, Codex, or any MCP-capable agent can draw, annotate, and refine diagrams alongside you. Canvases live locally under `~/.whiteboard/`, sync over WebSocket, and round-trip with stock `.excalidraw` JSON.

## Reach for whiteboard when…

- **You're aligning with your agent on a design and text alone keeps drifting.** Sketch the request flow once, ask the agent to fill in the missing edges, point at the diagram instead of re-explaining.
- **You're reviewing a change and want to mark up the architecture together.** Open an existing workspace, ask the agent to add the new path, compare against the previous frame, export a PNG for the PR description.
- **You're writing docs or onboarding material and want a reusable diagram.** Drive the agent to produce the diagram, save the `.excalidraw`, drop the PNG into the doc — open it again later in [excalidraw.com](https://excalidraw.com) when something needs updating.

## Quick install

The published artifact is the npm package `@kamiazya/whiteboard-mcp`, served over MCP `stdio`.

### Claude Code

```bash
claude mcp add whiteboard -- npx -y @kamiazya/whiteboard-mcp@latest
```

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.whiteboard]
command = "npx"
args = ["-y", "@kamiazya/whiteboard-mcp@latest"]
```

### Verify

In your agent session, ask it to call `canvas_create({ slug: "smoke" })`. The first call opens a Chromium tab pointed at the canvas and creates `~/.whiteboard/{workspaceId}/`.

> **Skills are an opt-in extra.** The commands above start the MCP server but do **not** install the bundled `/whiteboard`, `/whiteboard-coauthoring`, and `/whiteboard-audit` skills. To enable them, install the package locally and link `node_modules/@kamiazya/whiteboard-mcp/skills/` into `~/.claude/skills/` and `~/.codex/skills/`. See [docs/development.md](docs/development.md#bundled-skills-install) for the full link / junction recipes.

## Workspaces

Every canvas lives inside a workspace. The sidebar lets you switch between them instantly, and double-click to rename — no modal, no reload.

| Before | After rename |
|---|---|
| ![Workspace switcher with three workspaces listed](docs/assets/workspace-list.png) | ![The same list with one workspace renamed](docs/assets/workspace-list-renamed.png) |

> A "drawn with whiteboard" hero diagram is on the way — see [open follow-ups](#open-follow-ups) below.

## Bundled skills

Three opinionated `SKILL.md` packs ship inside the npm package and become slash skills once linked into `~/.claude/skills/` or `~/.codex/skills/`.

| Skill | When to use |
|---|---|
| `/whiteboard` | When screen layout, structure, flow, or comparison still feels too ambiguous in text alone — start drawing on the canvas together. |
| `/whiteboard-coauthoring` | A structured loop for evolving diagrams with the agent: gather context, structure frame by frame, run fresh-viewer tests on what you draw. |
| `/whiteboard-audit` | Audit existing workspaces — detect orphaned workspaces, tombstone-heavy canvases, and cache/disk mismatches; report cleanup candidates. |

## Example transcript

```
You    Use whiteboard to sketch the request flow for our auth service:
       client → API gateway → token service → DB. Highlight where caching lives.

Agent  → canvas_create({ slug: "auth-flow" })
       → annotate_batch([ /* 4 service boxes + arrows */ ])
       → annotate({ type: "label", text: "cache lives here", target: { x: 240, y: 360 } })
       → export_png()

       Drew a 4-stage flow on the auth-flow canvas. Cache callout placed
       between API gateway and token service. PNG attached.
```

The agent returns the `export_png` result as an MCP `ImageContent`, so the next turn can reason about what was actually drawn — closing the loop between prompt and pixels.

## Documentation

| Topic | Where |
|---|---|
| Local checkout, HTTP MCP development loop, repo-local config override, skill linking | [docs/development.md](docs/development.md) |
| Environment variables, storage layout, Codex sandbox quirks | [docs/configuration.md](docs/configuration.md) |
| Components, data flow, MCP tool surface, design boundaries | [docs/architecture.md](docs/architecture.md) |
| Custom template fragment JSON format used by `template_insert` | [docs/templates.md](docs/templates.md) |
| MCP debugging workflow (Inspector, `MCP_HTTP_DEBUG`, transport checks) | [docs/mcp-debugging.md](docs/mcp-debugging.md) |
| Token-gated local HTTP, daemon trust model | [docs/security-model.md](docs/security-model.md) |
| WebSocket message shapes between daemon and browser | [docs/wire-protocol.md](docs/wire-protocol.md) |
| Test layers, commit conventions, release process | [CONTRIBUTING.md](CONTRIBUTING.md) |

## Limitations

- Live drawing and PNG export require a Chromium browser tab connected over WebSocket.
- The published transport is `stdio`. The HTTP MCP endpoint (`pnpm mcp:http:dev`) is for local development.
- `/plugin marketplace add` is not supported yet — there is no `marketplace.json`. Install via `claude mcp add` or `npx` for now.

See [docs/configuration.md](docs/configuration.md#codex-sandbox-constraints) for sandbox quirks.

## Open follow-ups

Items intentionally not in this README yet — please file or upvote a tracking issue rather than adding noise inline:

- A "drawn with whiteboard" hero diagram and a short demo GIF, both produced with `pnpm dev` running.
- Cleaner in-canvas screenshots (the previous captures were debugging snapshots, removed for now).
- A published Claude Code plugin marketplace so `/plugin marketplace add kamiazya/whiteboard` works.

## License

[MIT](LICENSE)
