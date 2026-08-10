# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for this project. ADRs capture significant technical decisions, their context, and their consequences so future contributors can understand why things are the way they are.

## When to write an ADR

Write an ADR when a decision:

- Affects the architecture, public API, or cross-cutting contracts (schemas, transports, persistence formats).
- Will be difficult or expensive to reverse.
- Could surprise a contributor reading the code without context.
- Resolves a genuine tradeoff between competing approaches.

Do not write an ADR for routine implementation choices, style preferences, or decisions with a single obvious answer.

## Numbering

ADRs are numbered sequentially: `ADR-0001`, `ADR-0002`, etc. The filename follows the pattern `NNNN-short-title.md`. Numbers are never reused, even if an ADR is superseded.

## Status lifecycle

| Status | Meaning |
|---|---|
| **Proposed** | Under discussion; not yet adopted. |
| **Accepted** | Adopted; the decision is in effect. |
| **Superseded** | Replaced by a later ADR (link to the successor). |

## Template

See [template.md](template.md) for the standard structure (MADR-lite: Title, Status, Context, Decision, Consequences, Alternatives considered).

## Index

| ADR | Title | Status |
|---|---|---|
| [ADR-0001](0001-apps-web-canonical-frontend.md) | apps/web as the canonical frontend | Accepted |
| [ADR-0002](0002-browser-to-daemon-transport.md) | Browser-to-daemon transport for Stage 4 | Accepted |
| [ADR-0003](0003-track-claude-dev-flow-tooling.md) | Track .claude AI dev-flow tooling in git with repo-relative workflow scriptPaths | Accepted |
| [ADR-0004](0004-unified-capability-gated-canvas-page.md) | Unified capability-gated CanvasPage | Accepted |
| [ADR-0005](0005-hosted-origin-authorization.md) | Authorizing a hosted origin against the local daemon | Accepted — not yet implemented |
| [ADR-0006](0006-object-oriented-ui.md) | Object-oriented UI — create from the palette, act from the object | Accepted — one known violation |
