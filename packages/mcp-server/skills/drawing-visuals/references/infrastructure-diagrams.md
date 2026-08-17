# Infrastructure Diagrams

In infrastructure diagrams, lock down not just component names but **which boundary each component belongs to and how it connects**.

## Quick Map

- Decide first: boundary / main path / async path
- Drawing basics: boundary-first, main-path-first
- Semantic color and role consistency: prefer meaning over decoration
- Brand adaptation: adapt surrounding elements rather than forcing a component's own look
- Common failures: bad legend placement, hidden queues, overbearing boundaries

**No icon library.** This tool surface has no icon or template catalog — every component is a
labeled `text` or `group` node. Represent provider/product identity through labels, legends, and
consistent color, not through inserted artwork.

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

- If brand or design guidelines exist, apply them through labels, legends, and palette choice, not through custom shapes
- Define boundaries with a `group` node before placing components inside it
- Keep the main path left-to-right
- Push branches and async paths above or below the main path
- Represent the event bus as a small standalone node, not just an edge label

## Connection Labels

In infrastructure diagrams, edge labels may prioritize **protocol / transport over verbs**.

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

Pick a hex per role (see [`../style-reference.md`](../style-reference.md#colors) — the tool itself has no named color keys) and hold it steady:

- primary hex: client / edge / frontend
- success hex: service / compute
- warning hex: cloud / managed infra / provider boundary
- danger hex: security / auth / trust crossing
- info hex: region / cluster / metadata
- neutral hex: external system / legend / supporting boundary

## Role Consistency

- Keep gateway / LB / ingress consistent as entry-role elements
- Keep service / worker consistent as compute-role elements
- Keep queue / topic / bus consistent as standalone elements
- Keep database / cache / storage consistent as store-role elements
- Push external / third-party systems outside the boundary or into neutral treatment

Do not redraw the same role with a different look every time — keep it legible through labels, legends, and boundaries.

## Brand Adaptation

- Apply company / product brand colors through headings, legends, and boundaries
- If brand colors conflict with semantic colors, prioritize the semantic meaning for paths, security, trust boundaries, and similar elements
- Use branding as a reading aid, not as decoration; it is safer in legends than on the main path
- Adjust brand strength depending on whether the diagram is a review artifact or an external-facing asset

## Hard Rules

- Put legends / glossaries / notes outside the boundary
- Keep boundary labels short and place them in the top-left
- Limit node contents to `name + role + tech/port` by default
- Do not style sync and async paths the same way

## Common Failures

- The legend ends up inside a region or cluster
- A queue / bus is buried in an edge label
- Boundaries outshine the components
- A service node is overloaded with role / tech / port / SLA details

## If Stuck

- For layout recipes, see [`../style-reference.md`](../style-reference.md#architecture--data-flow-diagrams)
- For vocabulary, see `Show boundaries` and `Connection types` in [`../visual-vocabulary.md`](../visual-vocabulary.md)
