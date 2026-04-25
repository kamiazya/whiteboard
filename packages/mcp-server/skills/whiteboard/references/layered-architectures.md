# Layered Architectures

In layered architecture diagrams, separate **responsibility tiers and cross-cutting concerns**.

## Good Fits

- splitting user / app / data / infra
- splitting business / application / technology
- showing dependencies by tier
- placing monitoring / security / analytics as side concerns

## Shell

- Start with 3-6 layers
- Make layer names semantic
- Push cross-cutting concerns to a sidebar or another frame
- Keep the main flow to one path across layers

## Reading Direction

- Default to a top-to-bottom layer stack
- You may switch the emphasized flow to left-to-right, but do not break the layer meaning
- Put only parallel elements from the same layer in the same row / column

## Per-Layer Patterns

- simple grid: peer components
- subgroup: lower-level splits such as sync / async
- product group: parallel products or domains
- KPI row: metrics or SLOs
- mixed width: different visual weight for primary vs secondary elements

## Hard Rules

- Do not mix actors, services, and storage in the same tier
- Keep layer labels short
- If arrows cross layer titles, redo the layout
- Do not scatter cross-cutting concerns inside the main layers
- If an arrow skips a layer, make the reason explicit

## Common Failures

- Too many layers kill hierarchy
- The tier meaning is unreadable from the box arrangement alone
- Monitoring / governance sticks to the main path
- The data layer turns into a list of technology names only

## Local Surgery

- If a layer is too thin: merge it with an adjacent layer
- If a layer is too thick: split it into subgroups or product groups
- If a cross-cutting concern gets in the way: move it to a sidebar
- If dependencies cross too much: separate the main flow from side flows

## If Stuck

- For basic structural diagrams, see [`./flow-and-architecture.md`](./flow-and-architecture.md)
- For cloud / subnet issues inside a layer, see [`./infrastructure-diagrams.md`](./infrastructure-diagrams.md)
