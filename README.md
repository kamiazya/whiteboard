# @kamiazya/whiteboard

<p align="center">
  <img src="docs/assets/readme-mark.svg" alt="Whiteboard — a hand sketches nodes and edges, AI tidies them into a diagram, and the mark returns" width="264" height="222" />
</p>

> A collaborative whiteboard for Claude Code, Codex, and Gemini CLI. Draw with your AI agent to align on specs, architecture, and workflows — directly on a shared real-time canvas.

[![npm version](https://img.shields.io/npm/v/@kamiazya/whiteboard-mcp.svg)](https://www.npmjs.com/package/@kamiazya/whiteboard-mcp)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/kamiazya/whiteboard/actions/workflows/ci.yml/badge.svg)](https://github.com/kamiazya/whiteboard/actions/workflows/ci.yml)

## Start here

whiteboard is a **browser-first whiteboard that grows with you**: open a canvas in
your browser, run it locally for durable private storage, and self-host it for a
team when you're ready.

**Try it in your browser** — no account; your canvas data stays in your own
browser. <sub>*Browser-local: runs in your browser, data stays on your machine.*</sub>
*[Get started →](docs/tutorials/getting-started.md) — runs locally from a checkout today.*

### ▶ Draw with your AI agent

The fastest way to get value today. Claude Code, Codex, or Gemini draw on the
canvas alongside you over MCP. <sub>*Local daemon: a server on your own machine.*</sub>

**→ [Get started: Quick install](#quick-install)**

---

**Self-host for your team** — run whiteboard as a shared server behind your own
identity provider and TLS. <sub>*Server mode: a shared server you operate.*</sub>
→ [Self-host with Docker](docs/how-to/self-host-with-docker.md)

## How whiteboard works

You and your agent both reach the same whiteboard — they talk, the agent acts, skills shape the prompts. The `kamiazya/whiteboard` plugin packages three skills and a Whiteboard MCP server together; the agent calls MCP tools via stdio and the daemon syncs the canvas to your browser over WebSocket.

<p align="center">
  <img src="docs/assets/architecture.png" alt="Architecture diagram: Skills and Whiteboard MCP are packaged in the kamiazya/whiteboard Plugin. You and Agent (Claude/Codex/Gemini) interact via prompts/replies; Agent calls Whiteboard MCP via stdio; MCP controls the Browser Canvas via HTTP/WS." width="780" />
  <br />
  <sub><i>Diagram drawn with whiteboard itself — see <a href="docs/assets/architecture.canvas">architecture.canvas</a> to open it as a JSON Canvas document and remix.</i></sub>
</p>

`@kamiazya/whiteboard-mcp` runs a spatial canvas editor in your browser and exposes MCP tools so Claude Code, Codex, Gemini CLI, or any MCP-capable agent can draw, annotate, and refine diagrams alongside you. Canvases live locally under `~/.whiteboard/`, sync over WebSocket, and are stored as OKF Markdown or JSON Canvas 1.0 — both round-trip losslessly through the same codec that exports the PNG/SVG images on this page.

<p align="center">
  <img src="docs/assets/canvas-browser-ui.png" alt="The browser canvas: workspace and canvas selector in the top bar, live diagram synced from the agent in real time" width="780" />
</p>

## Reach for whiteboard when…

- **You're aligning with your agent on a design and text alone keeps drifting.** Sketch the request flow once, ask the agent to fill in the missing edges, point at the diagram instead of re-explaining.
- **You're reviewing a change and want to mark up the architecture together.** Open an existing workspace, ask the agent to add the new path, compare against the previous frame, export a PNG for the PR description.
- **You're writing docs or onboarding material and want a reusable diagram.** Drive the agent to produce the diagram, drop the exported PNG into the doc, and keep the canvas itself around to reopen and update later.

| Aligning on a design | Reviewing and marking up | Presenting or sharing |
|:---:|:---:|:---:|
| ![Agent drew the architecture diagram](docs/assets/canvas-agent-drew.png) | ![Review notes added by the user](docs/assets/canvas-user-annotated.png) | ![Chrome-free canvas render](docs/assets/canvas-presentation.png) |
| **Agent drew it** — you guided the layout | **You annotated it** — review notes on the canvas | **Chrome-free render** — clean export for docs |

The same workflow works across any scenario — the agent draws boxes, arrows, and labels on a fresh canvas:

<p align="center">
  <img src="docs/assets/canvas-auth-flow.png" alt="Auth service request flow: client → API Gateway → Token Service → Database, with Redis Cache path shown" width="640" />
  <br />
  <sub><i>Auth service flow drawn by the agent — numbered steps, cache callout, color-coded components.</i></sub>
</p>

## Quick install

### Claude Code

In a Claude Code session, run:

```
/plugin marketplace add kamiazya/whiteboard
/plugin install whiteboard@whiteboard-marketplace
```

This installs the MCP server **and** the bundled `/drawing-visuals`, `/coauthoring-visuals`, and `/auditing-workspaces` skills in one step.

<details>
<summary>MCP only (no skills)</summary>

```bash
claude mcp add whiteboard -- npx -y @kamiazya/whiteboard-mcp@latest
```

> Starts the MCP server only — the `/drawing-visuals`, `/coauthoring-visuals`, and `/auditing-workspaces` skills are **not** installed this way. [Link them manually →](docs/contributing/development.md#bundled-skills-install)

</details>

### Codex

In a Codex session, run:

```
codex plugin marketplace add kamiazya/whiteboard@stable
```

The `@stable` pin tracks the latest release instead of the development branch.

Then open `/plugins`, choose **kamiazya Whiteboard → whiteboard → Install plugin**, and restart Codex. This installs the MCP server **and** the bundled skills in one step.

<details>
<summary>MCP only (no skills)</summary>

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.whiteboard]
command = "npx"
args = ["-y", "@kamiazya/whiteboard-mcp@latest"]
```

> Starts the MCP server only — the `/drawing-visuals`, `/coauthoring-visuals`, and `/auditing-workspaces` skills are **not** installed this way. [Link them manually →](docs/contributing/development.md#bundled-skills-install)

</details>

### Gemini CLI

```bash
gemini extensions install https://github.com/kamiazya/whiteboard
```

<details>
<summary>MCP only (no extension)</summary>

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "whiteboard": {
      "command": "npx",
      "args": ["-y", "@kamiazya/whiteboard-mcp@latest"]
    }
  }
}
```

> Starts the MCP server only — the `/drawing-visuals`, `/coauthoring-visuals`, and `/auditing-workspaces` skills are **not** installed this way. [Link them manually →](docs/contributing/development.md#bundled-skills-install)

</details>

### Verify

In your agent session, ask it to call `wb_document_create({ workspaceId: "default", path: "smoke", kind: "spatial" })`. The call creates `~/.whiteboard/{workspaceId}/`; open `http://127.0.0.1:<port>/w/{workspaceId}/canvas/smoke` in a browser tab to see it.

## Pair with your local daemon

Already have the browser canvas open (see [Get started](docs/tutorials/getting-started.md))
and a local daemon running? Ask your AI agent to call the `create_pairing_link`
MCP tool. It mints a `#wb=` link that carries a short-lived bootstrap token —
open it in your browser to connect that tab to the daemon's workspaces,
version history, branches, and merge, with live sync over WebSocket.

- Loopback web origins (`http://127.0.0.1:...`) need no extra configuration.
- The official hosted web app (`https://kamiazya-whiteboard.pages.dev`) can
  pair out of the box; other HTTPS hosted origins must be added to
  `WHITEBOARD_ALLOWED_WEB_ORIGINS` (which, when set, replaces that default). This setting governs
  local-daemon pairing only; [server mode](docs/how-to/self-host-with-docker.md)
  reads the separate `WHITEBOARD_SERVER_ALLOWED_ORIGINS` variable instead.
- Treat the pairing link like a credential: anyone who has it can pair with
  your daemon until the token is rotated.
- Prefer a config file over exporting env vars by hand? See
  [Configuration → Config file](docs/reference/configuration.md#config-file-local-daemon)
  for the `.whiteboardrc` / `.whiteboard/config.yaml` auto-load and
  precedence rules.

See [Connect to a local daemon](docs/how-to/connect-to-local-daemon.md) for
the full flow, including copy-first import of browser-local canvases.

## Bundled skills

Three opinionated `SKILL.md` packs ship inside the npm package. The recommended **plugin install above wires them up automatically** — no manual linking. If you instead used `claude mcp add`, the Codex CLI snippet, or `npx`, link them yourself per [docs/contributing/development.md#bundled-skills-install](docs/contributing/development.md#bundled-skills-install).

| Skill | When to use |
|---|---|
| `/drawing-visuals` | When screen layout, structure, flow, or comparison still feels too ambiguous in text alone — start drawing on the canvas together. |
| `/coauthoring-visuals` | A structured loop for evolving visuals with the agent: gather context, structure frame by frame, run fresh-viewer tests on what you draw. |
| `/auditing-workspaces` | Audit existing workspaces — detect orphaned workspaces, tombstone-heavy canvases, and cache/disk mismatches; report cleanup candidates. |

## Example transcript

```text
You    Use whiteboard to sketch the request flow for our auth service:
       client → API gateway → token service → DB. Highlight where caching lives.

Agent  { canvasId } = wb_document_create({ workspaceId: "default",
                                          path: "auth-flow", kind: "spatial" })
       wb_node_add({ canvasId, node: /* one of 4 service boxes */ })
       wb_edge_add({ canvasId, edge: /* an arrow between two of them */ })
       wb_node_add({ canvasId, node: { id: "cache-note", type: "text",
                                       x: 240, y: 360, text: "cache lives here" } })
       wb_scene_render({ canvasId })

       Drew a 4-stage flow on the auth-flow canvas. Cache callout placed
       between API gateway and token service. SVG attached.
```

The agent returns the `wb_scene_render` result so the next turn can reason about what was actually drawn — closing the loop between prompt and pixels.

## Documentation

| Topic | Where |
|---|---|
| Local checkout, HTTP MCP development loop, repo-local config override, skill linking | [docs/contributing/development.md](docs/contributing/development.md) |
| Environment variables, storage layout, Codex sandbox quirks | [docs/reference/configuration.md](docs/reference/configuration.md) |
| Components, data flow, MCP tool surface, design boundaries | [docs/explanation/architecture.md](docs/explanation/architecture.md) |
| Export formats (SVG, OKF Markdown, JSON Canvas) and their tools | [docs/reference/export-formats.md](docs/reference/export-formats.md) |
| MCP debugging workflow (Inspector, `MCP_HTTP_DEBUG`, transport checks) | [docs/contributing/mcp-debugging.md](docs/contributing/mcp-debugging.md) |
| Trust model for all three runtimes (browser-local, local daemon, server mode) | [docs/explanation/security-model.md](docs/explanation/security-model.md) |
| Pairing a browser tab to a local daemon, copy-first import | [docs/how-to/connect-to-local-daemon.md](docs/how-to/connect-to-local-daemon.md) |
| WebSocket message shapes between daemon and browser | [docs/contributing/architecture/wire-protocol.md](docs/contributing/architecture/wire-protocol.md) |
| Test layers, commit conventions, release process | [CONTRIBUTING.md](CONTRIBUTING.md) |

## Limitations

- No MCP tool currently returns a raster (PNG) image or `ImageContent` — `wb_scene_render` is the closest equivalent for handing a rendered canvas back to an LLM.
- The published transport is `stdio`. The HTTP MCP endpoint (`pnpm mcp:http:dev`) is for local development.

See [docs/reference/configuration.md](docs/reference/configuration.md#codex-sandbox-constraints) for sandbox quirks.

## License

[Apache-2.0](LICENSE).

The whole codebase lives in this public monorepo. Today every package is Apache-2.0. The relicense applies to this source tree and to releases made from it going forward; npm versions published before the switch remain MIT-licensed. When the managed-hosting (SaaS) composition layer lands, only that layer — the Cloudflare Workers app and its Cloudflare-specific storage adapters — will be published under the [Fair Source License (FSL-1.1-Apache-2.0)](https://fsl.software/): free to self-host and use internally, not usable to offer a competing hosted service, and automatically becoming Apache-2.0 two years after each release. Everything else stays Apache-2.0.

The project name and logo are not licensed for use in third-party commercial hosting offerings.
