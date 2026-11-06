# Contributing to Whiteboard

Developer- and maintainer-facing documentation for people changing this repository. End users
do not need anything here — user-facing docs live under the [documentation home](../).

Contributor and maintainer guides:

- **[development](development.md)** — local checkout and the HTTP MCP development loop.
  Before opening a PR, `pnpm check:local` mirrors CI's `check` job locally (see CONTRIBUTING.md's checklist).
- **[testing](testing.md)** — test strategy, layer selection, property/mutation testing, and quality gates.
- **[mcp-debugging](mcp-debugging.md)** — debugging the MCP server during development.
- **[releasing](releasing.md)** — release-please and npm/GHCR publishing.
- **[observability](observability.md)** — OpenTelemetry tracing for the daemon and MCP entrypoint.
- **[quality-requirements](quality-requirements.md)** — the development quality bar, language-neutral and numbered (QR-1…): each requirement, the defect class it guards, how TypeScript and Rust meet it, and its gate level; ends with the parity checklist a Rust port meets before it replaces TypeScript ([ADR-0054](adr/0054-rust-core.md)).
- **[review-checklist](review-checklist.md)** — checklist for PR authors and reviewers.
- **[security-baseline](security-baseline.md)** — the OpenSSF control matrix (Scorecard, OSPS Baseline, Best Practices badge, SLSA, SSDF): what is met, what the repository can still close, and what only the owner can.
- **[deployment/cloudflare-pages](deployment/cloudflare-pages.md)** — deploying the hosted browser app.
- **[architecture/wire-protocol](architecture/wire-protocol.md)** — the live-sync wire-protocol reference (the architecture overview is [explanation/architecture](../explanation/architecture.md)).
- **[architecture/canvas-render-decisions](architecture/canvas-render-decisions.md)** — the measurements, rejected alternatives and incident history behind the canvas-render package's standing rules, which `.claude/rules/package-canvas-render.md` keeps in short form.
- **[adr/](adr/)** — Architecture Decision Records (MADR-lite; numbered, lifecycle-tracked).

See also the repo-root [CONTRIBUTING.md](../../CONTRIBUTING.md) and [AGENTS.md](../../AGENTS.md).

← Back to [documentation home](../)
