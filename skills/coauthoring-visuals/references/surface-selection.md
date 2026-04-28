# Surface Selection

The important idea to borrow from `visual-explainer` is to decide **whether whiteboard is even the right surface before choosing a diagram family**.

## Start With Surface

Decide this first:

- whiteboard only
- whiteboard + mermaid
- whiteboard + table
- whiteboard + memo / visual page
- slide deck

Whiteboard is strong for structure, causality, boundaries, and handoffs.
Dense tables, long inventories, and diagrams dominated by structured grammar are often better on another surface.

## Use Whiteboard When

- you want to show topology
- you want the viewer to follow a flow / sequence / boundary
- you want to compare `current / problem / proposal`
- you want the structure to read within 5 seconds

## Use Whiteboard + Mermaid When

- the canonical artifact should stay in text / diff / version control
- source material already exists in Mermaid
- the grammar is strongly structured, such as sequence / state / ER / C4 / timeline / gantt
- even a flowchart gets enough meaning from direction / subgraph / edge label, and auto-layout helps
- the whiteboard should carry overview and commentary while the diagram source-of-truth remains in code

If you choose this, also open [`./mermaid-companion-patterns.md`](./mermaid-companion-patterns.md).
Mermaid is the canonical source; the whiteboard handles framing, comparison, and callouts.

## Use A Companion Table Or Page When

- a structured comparison with 4+ rows or 3+ columns is the main content
- the main task is audit / inventory / requirements matrix
- you want multiple code snippets or file tables side by side
- there are 4+ sections and navigation matters

Do not force everything into the whiteboard.
Keep overview on the canvas and push dense detail into a companion artifact.

## Hybrid Pattern

The most common case is hybrid:

- frame 1: overview / system shape
- frame 2: key flow or boundary
- companion mermaid: canonical flowchart / sequence / state / ER / C4 / timeline
- companion table/page: detailed comparison, audit, command inventory, file map

Validate the Mermaid companion before export, then include its PNG/SVG in the fresh-viewer test.

Let the diagram carry structure and the companion artifact carry detail.

## Slide Deck Rule

Choose slide deck **only when the ask is explicit**.

- presentation
- review meeting
- shareable walkthrough

If slides were not explicitly requested, a scrollable page or table is often enough.
If you choose slides, also open [`./slide-deck-patterns.md`](./slide-deck-patterns.md).

## Smells

Re-cut the surface if any of these appear:

- frames are full of paragraphs
- the viewer needs excessive zoom just to read detail
- a comparison is really a table recreated as a cluster of boxes
- a file list or command list has become a wall of boxes
- actor order, state transitions, or entity relations are being manually realigned every time

## Quick Heuristic

- shape first -> whiteboard
- structured grammar + auto-layout + diffability -> mermaid
- compare many fields -> table
- explain many sections -> page
- present a narrative -> slides
