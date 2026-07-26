# Infrastructure Diagrams

In infrastructure diagrams, lock down not just component names but **which boundary each component belongs to and how it connects**.

## Quick Map

- Decide first: boundary / main path / async path
- Drawing basics: library-first, boundary-first, main-path-first
- Semantic color and role consistency: prefer meaning over decoration
- Brand adaptation: adapt surrounding elements rather than forcing the icon itself
- Common failures: bad legend placement, hidden queues, overbearing boundaries

If you need nested cloud/network zones or physical vs logical path techniques, also open [`./cloud-and-network-zones.md`](./cloud-and-network-zones.md).
If trust boundaries / auth / audit are the main subject, also open [`./trust-boundary-and-security.md`](./trust-boundary-and-security.md).

## Decide These First

- Which boundary is the focal one?
  - `AWS Region`
  - `VPC`
  - `Kubernetes Cluster`
  - `Private Subnet`
  - `Trust Boundary`
- What is the main path?
  - `client -> edge -> gateway -> service -> data`
- Is there an async path?
  - Should the queue / topic / bus be a standalone element?

## Drawing Basics

- If you need icons, use `library_*` tools first
- If the library item names are unclear, do a **trial insert** on a scratch canvas before adopting them
- A `library_insert_batch` contact sheet grouped with `groupAs` is easier to clean up after trial inserts
- Once the index is known, store aliases and recommended scale with `user_library_metadata_get` / `user_library_metadata_set`
  - for example, `cloud_run -> 13`
- Recommended scale captures whether the default insert feels too large or too small
  - If you insert via `userLibraryName`, the stored scale is applied automatically, so leave a short note in `notes` too
- If you cannot assume a dedicated subagent, hand [`library-research-prompt-template.md`](./library-research-prompt-template.md) to a General Subagent to research item indices and scales
- If brand or design guidelines exist, research not just the icon choice but also how labels, frames, legends, and palettes should behave
- Alias-based insert does not exist yet, so production inserts still need the explicit index read from metadata
- Define boundaries with a `group` or `frame` before placing components
- Keep the main path left-to-right
- Push branches and async paths above or below the main path
- Represent the event bus as a small box, not just an arrow label

## Connection Labels

In infrastructure diagrams, arrow labels may prioritize **protocol / transport over verbs**.

Good examples:
- `HTTPS`
- `gRPC`
- `SQL`
- `events`
- `JWT`
- `TLS`

Bad examples:
- `backend sends validated messages`
- `service talks to database securely`

## Semantic Color Guide

- `primary`: client / edge / frontend
- `success`: service / compute
- `warning`: cloud / managed infra / provider boundary
- `danger`: security / auth / trust crossing
- `info`: region / cluster / metadata
- `neutral`: external system / legend / supporting boundary

## Role Consistency

- Keep gateway / LB / ingress consistent as entry-role elements
- Keep service / worker consistent as compute-role elements
- Keep queue / topic / bus consistent as standalone elements
- Keep database / cache / storage consistent as store-role elements
- Push external / third-party systems outside the boundary or into neutral treatment

Do not redraw the same role with a different look every time.
Even when using provider icons, keep the role legible through labels, legends, and boundaries.

## Brand Adaptation

- Apply company / product brand colors through headings, legends, and boundaries
- Do not force provider icons toward the brand if that hurts recognizability
- If brand colors conflict with semantic colors, prioritize the semantic meaning for paths, security, trust boundaries, and similar elements
- Use branding as a reading aid, not as decoration; it is safer in legends and frames than on the main path
- Adjust brand strength depending on whether the diagram is a review artifact or an external-facing asset

## Hard Rules

- Put legends / glossaries / notes outside the boundary
- Keep boundary labels short and place them in the top-left
- Limit box contents to `name + role + tech/port` by default
- Do not style sync and async paths the same way
- Do not repaint third-party icons into brand colors in a way that blurs their meaning

## Common Failures

- The legend ends up inside a region or cluster
- A queue / bus is buried in an arrow label
- Boundaries outshine the components
- A service box is overloaded with role / tech / port / SLA details

## If Stuck

- For recipes, see `Infrastructure / Network diagrams` in [`../style-reference.md`](../style-reference.md)
- For vocabulary, see `Show boundaries` and `Connection types` in [`../visual-vocabulary.md`](../visual-vocabulary.md)
