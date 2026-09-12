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
| [ADR-0006](0006-object-oriented-ui.md) | Object-oriented UI — create from the palette, act from the object | Accepted |
| [ADR-0007](0007-canvas-identity-and-store-split.md) | Canvas identity and the daemon's two-store split | Accepted — says *slug* for what is now *path* |
| [ADR-0008](0008-slug-derivation-and-rename.md) | Slug derivation, rename, and sibling uniqueness | Accepted — read *slug* as *path* |
| [ADR-0009](0009-mcp-tool-naming.md) | The Document model, and `wb_<entity>_<action>` tool naming | Accepted — decisions 3-4 now implemented; *format* is spelled `kind` |
| [ADR-0010](0010-canvas-edit-batch-tool.md) | One batch tool for spatial editing, and why it is not `apply` | Accepted |
| [ADR-0011](0011-font-distribution.md) | Fonts are installed by whoever needs them, not bundled | Accepted — provider registry not built yet |
| [ADR-0012](0012-user-installed-fonts.md) | A user installs a font by naming it, and the daemon keeps it | Accepted — not yet implemented; extends ADR-0011 |
| [ADR-0013](0013-facet-system.md) | The facet system — plugins, versioned facet keys, and the meaning/display split | Accepted — key grammar landed; supersedes ADR-0009 decision 3 |
| [ADR-0014](0014-reference-index.md) | Cross-document references are a derived projection with an event-fed aggregate | Accepted |
| [ADR-0015](0015-search-quality-scoreboard.md) | A judged corpus decides whether search needs embeddings | Accepted |
| [ADR-0016](0016-okf-trust-family.md) | OKF v0.2 trust family: a declared actor, a server-stamped time, and a bucket of its own | Accepted — daemon write path only |
| [ADR-0017](0017-okf-bundle-mapping.md) | Mapping a workspace onto an OKF bundle | Proposed — design only |
| [ADR-0018](0018-operation-vs-mechanic.md) | An operation is a use case; the composition root holds only mechanics | Proposed |
| [ADR-0019](0019-workspace-identity.md) | Workspace identity is three layers, in both keepers | Proposed |
| [ADR-0020](0020-coordination-boundary.md) | The coordination boundary — a CRDT data plane and a compare-and-swap control plane | Proposed |
| [ADR-0021](0021-durability-boundary.md) | Durability is a property of each store, not an operation on a directory | Accepted (implemented) |
| [ADR-0022](0022-variation-addressing.md) | A variation is not in the address, and the default one has no name to put there | Accepted — decision 1's grammar rule stands; the variation surface it addresses is retired by ADR-0029 |
| [ADR-0023](0023-replica-model.md) | A workspace has one keeper; every other copy is a replica | Accepted — implemented (verified demote deletes the browser copy; replicas serve offline reads) |
| [ADR-0024](0024-canvas-comments.md) | Canvas comments are a first-class annotation layer, keyed per comment | Accepted |
| [ADR-0025](0025-comment-editor-ux.md) | Comment editor UX: context-menu create, resolved toggle, authorless v1, pull-by-convention AI delivery | Accepted |
| [ADR-0026](0026-annotation-layer.md) | The annotation layer — one plane per document, threads, and selector anchors | Proposed — design of record for comments beyond the canvas |
| [ADR-0027](0027-render-broker.md) | Every picture of a document goes through one broker, and the cache is a memo | Accepted — in-tab broker landed; OPFS persistence and the SharedWorker implementation are follow-ups |
| [ADR-0028](0028-quiet-persistence.md) | The routine save state is not shown; the shell mark speaks only for a condition | Accepted — the browser page's save chip is removed, the shell mark carries both keepers' health; writing at once (no debounce window) is the named follow-up |
| [ADR-0029](0029-proposal-layer.md) | A proposal is an anchored change, not a point in time | Accepted — design of record; nothing implemented yet. Retires the variation surface of ADR-0022 |
| [ADR-0030](0030-render-theme.md) | A render theme is a document's pen and paper — a canvas facet naming a registered asset | Accepted — design of record (human gate 2026-09-09); nothing implemented yet. Extends ADR-0013, binds canvas-render decision #10 |
| [ADR-0031](0031-tool-surface-criteria.md) | The tool surface is judged by an instrument, not by its count | Accepted — criteria, the pinned tool-surface scoreboard and the opt-in LLM-driven lane land together; the retirements it points at are follow-ups |
| [ADR-0032](0032-composition-axis.md) | A composition axis — what a drawing hands its reader, judged by four principles with their sources | Accepted — criteria, columns, validity claim, and the score and pinned scoreboard that land with them. Sits beside ADR-0031 §7's drawing score |
| [ADR-0033](0033-facet-vocabulary-axis.md) | A facet-vocabulary axis — whether what a reader can SEE matches what the document DECLARES | Accepted — criteria, columns, validity claim, and the score and pinned baseline that land with them. Sits beside ADR-0031 §7 and ADR-0032, and takes over the question ADR-0032's `contrast` reserved |
| [ADR-0034](0034-stencil-and-recipe.md) | Stencil and recipe — a reusable element and a reusable arrangement, as two concepts | Proposed — the vocabulary, the boundaries (a recipe never emits coordinates; a library is data, not a distribution-time schema), the granularity criterion, and the measurement plan. Stencils land first |
| [ADR-0035](0035-device-keys-and-keeper.md) | A key belongs to a device, and a server keeps rather than vouches | Accepted. Decisions 1-2 implemented for the daemon (a `did:key` it derives, advertises and stamps as a version's actor); browser keys, checkpoint signatures, sharing, E2EE and the user DID's method deferred with triggers. Extends ADR-0016's self-report admission and ADR-0023's keeper model |
| [ADR-0036](0036-semantic-axes.md) | A semantic axis is declared, and a channel carries at most one | Accepted, and carried out — the instrument, the declaration, and the bundled stencils' move off the colour channel. Extends ADR-0033's columns and constrains what ADR-0034's stencil may spend |
