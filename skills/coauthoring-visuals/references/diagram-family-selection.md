# Diagram Family Selection

The value to borrow from `markdown-viewer/skills` is not syntax, but the judgment of **which diagram family fits which question**.

## Quick Map

- Pick The Family First: choose the family before detailing content
- Family Cues: which questions and compositions each family suits
- Build Order: move from shell to detail
- Per-Layer Patterns: recurring internal patterns for layers / lanes / zones
- Cross-Cutting Concerns: what should be pushed into sidebars or other frames
- Corresponding Drawing Notes: where to open the matching `drawing-visuals` notes

## Pick The Family First

Do not start with "what do I want to explain?"
Start with **which visual grammar should the viewer use to read this?**

- decomposition: topic breakdown, option tree, decision tree
- layered architecture: responsibilities, tiers, dependencies
- workflow / swimlane: procedure, handoff, role-based flow
- trust-boundary / security: authentication, authorization, audit, boundary crossing
- cloud / network zone: region, VPC, subnet, public/private, physical/logical
- comparison split: current / problem / proposal, before / after, A/B
- pipeline / roadmap: stage progression, ETL, CI/CD, migration sequence
- enterprise landscape: business / application / technology / motivation / implementation

## When Mermaid Is The Better Companion

Before you commit to a whiteboard family, ask whether **structured grammar should live in a separate artifact**.

- sequence: participant order and message grammar should stay text-based
- flowchart: direction, subgraph, and edge label should remain canonical
- state: state machine should stay diffable
- entity relationship: schema should remain text-first
- timeline / gantt: chronology is the main content
- C4: context / container / component / deployment should remain canonical

In those cases, consider `whiteboard + mermaid` first.
The whiteboard carries overview, emphasis, comparison, and commentary.
Mermaid carries the structured source-of-truth.
If chosen, also open [`./mermaid-companion-patterns.md`](./mermaid-companion-patterns.md).

## Family Cues

### Decomposition

Use it when:
- the issues are still scattered
- you want to split topics before entering architecture
- you want to show a choice tree or classification

Helpful compositions:
- tree
- mind map
- bilateral pros/cons

### Layered Architecture

Use it when:
- you want to show responsibilities across user / app / data / infra
- you want to separate business / application / technology
- you want cross-cutting concerns to sit outside the main shell

Helpful compositions:
- vertical layer stack
- 3-column with sidebars
- subgroup / product group / KPI row

### Workflow / Swimlane

Use it when:
- the key question is who hands what to whom and when
- you are showing an approval chain
- cross-team handoff matters

Helpful compositions:
- left-to-right flow
- pool / lane
- vertical stack for ordered steps

### Trust-Boundary / Security

Use it when:
- the flow is user -> auth -> authz -> resource
- trust boundaries matter
- audit / async detection matters

Helpful compositions:
- access flow
- trust zone
- dashed audit path

### Cloud / Network Zone

Use it when:
- the subject is cloud deployment
- VPC / region / subnet boundaries matter
- public/private split matters
- both physical links and logical flow must be shown

Helpful compositions:
- nested zones
- region / VPC / subnet grouping
- cloud boundary plus zone labels

### Comparison Split

Use it when:
- comparing `current / problem / proposal`
- comparing before / after
- comparing option A / B

Helpful compositions:
- mirrored two-column
- repeated frame pattern
- same comparison axis across frames

### Pipeline / Roadmap

Use it when:
- the subject is ETL
- the subject is CI/CD
- migration phases matter
- a staged rollout matters

Helpful compositions:
- inline pipeline
- numbered vertical stack
- milestone row

## Build Order

Build complex diagrams in this order:

1. choose the family and reading direction
2. place the shell: frame / sidebar / lane / layer / zone
3. fill each layer or lane
4. add connectors
5. add evidence / legend / KPI / annotations last

## Per-Layer Patterns

For layered families, choose an internal arrangement too:

- simple grid: peer components
- subgroup: lower-level split such as sync vs async
- product group: multiple products or domains
- KPI row: show metrics
- vertical stack: ordered steps
- nested zones: isolation boundary
- mixed width: primary plus secondary

## Cross-Cutting Concerns

Push things that become noisy on the main path into a sidebar or a separate frame:

- monitoring
- security / compliance
- governance
- analytics

Do not let these become scattered boxes crossing the main connectors.

## Corresponding Drawing Notes

Once the family is chosen, open the matching drawing note in the `drawing-visuals` skill:

- decomposition: [`../../drawing-visuals/references/decomposition-and-trees.md`](../../drawing-visuals/references/decomposition-and-trees.md)
- layered architecture: [`../../drawing-visuals/references/layered-architectures.md`](../../drawing-visuals/references/layered-architectures.md)
- workflow / swimlane: [`../../drawing-visuals/references/workflows-and-swimlanes.md`](../../drawing-visuals/references/workflows-and-swimlanes.md)
- trust-boundary / security: [`../../drawing-visuals/references/trust-boundary-and-security.md`](../../drawing-visuals/references/trust-boundary-and-security.md)
- cloud / network zone: [`../../drawing-visuals/references/cloud-and-network-zones.md`](../../drawing-visuals/references/cloud-and-network-zones.md)
- comparison split: [`../../drawing-visuals/references/comparison-splits.md`](../../drawing-visuals/references/comparison-splits.md)
- pipeline / roadmap: [`../../drawing-visuals/references/pipelines-and-roadmaps.md`](../../drawing-visuals/references/pipelines-and-roadmaps.md)
