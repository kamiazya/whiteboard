# Whiteboard documentation

Whiteboard is a canvas you and an AI agent can draw on together.

> **Note for contributors:** the persona "doors" below are structural — the three entry points
> and their targets are confirmed, but the final value/positioning wording is owned by
> marketing and is marked _(copy TBD)_ until the persona review is folded in.

## Start here

Whiteboard is a **browser-first whiteboard that grows with you** — open a canvas in your
browser, optionally run it locally for durable private storage, and self-host it for a team
when you're ready. Pick where you are:

| I want to… | Start with |
|---|---|
| **Just try it in my browser** — no install, no account; my data stays in my browser | [Open a browser canvas →](tutorials/) <sub>(zero-install · Browser-local)</sub> |
| **Draw with my AI agent** (Claude Code, Codex, Gemini) | [Connect an AI agent →](tutorials/) <sub>(Local daemon + MCP)</sub> |
| **Self-host for my team** | [Self-host with Docker →](how-to/) <sub>(Server mode)</sub> |

<sub>During the docs migration these doors land on the section index; the specific pages
(`first-browser-canvas`, `connect-an-ai-agent`, `self-host-with-docker`) arrive in later
slices. The "try it in your browser" destination is a placeholder until a canonical hosted URL
is chosen — live preview origins are intentionally blocked.</sub>

## The four kinds of docs (Diátaxis)

This documentation follows the [Diátaxis](https://diataxis.fr/) framework:

- **[Tutorials](tutorials/)** — learning-oriented. Start here if you are new and want a guided
  "follow along and it works" path.
- **[How-to guides](how-to/)** — goal-oriented. Steps to accomplish a specific task.
- **[Reference](reference/)** — information-oriented. Configuration, formats, and contracts,
  stated precisely.
- **[Explanation](explanation/)** — understanding-oriented. How the runtimes fit together and
  why the design is the way it is.

## Runtimes at a glance

Whiteboard has three runtimes (see [Explanation](explanation/) for detail):

- **Browser-local** — the zero-install hosted browser app; your data stays in the browser.
- **Local daemon** — a server you run on your own machine (loopback only) for MCP/agent work.
- **Server mode** — the server run for a team beyond loopback, behind OAuth/JWT and your own TLS.

---

_Working on Whiteboard itself? See [Contributing to this repo](contributing/)._
