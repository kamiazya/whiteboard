# Mermaid Companion Patterns

What matters to borrow from `Agents365-ai/mermaid-skill` is not Mermaid syntax itself, but **when auto-layout is the right choice** and **the discipline of treating the companion artifact with validation-first rules**.

## Quick Map

- When Mermaid Helps: what kinds of questions justify `whiteboard + mermaid`
- Canonical Source Rule: which artifact is the source-of-truth
- Validation Pass: what to confirm before export
- Family Notes: how flowchart / sequence / state / ER / C4 differ
- Import Implications: what meaning a whiteboard import must preserve

## When Mermaid Helps

Mermaid is strongest when **grammar matters more than manual coordinates**.

- participant order or state transition should stay fixed in text
- the source should stay reviewable in diff / version control
- auto-layout gives you a fast first pass
- constructs like subgraph, alt, loop, and par preserve the intended meaning
- the whiteboard should show overview and commentary while the structured core stays in text

In contrast, if spatial composition itself carries the claim, or whitespace and hierarchy are the point, whiteboard-first is often better.

## Canonical Source Rule

If you choose `whiteboard + mermaid`, split responsibilities explicitly:

- Mermaid: canonical grammar, stable ordering, diffable source
- whiteboard: framing, emphasis, commentary, comparison, callouts

When Mermaid is the companion, do not treat the whiteboard as the source-of-truth.
Do not assume manual whiteboard edits must round-trip back into Mermaid.

## Validation Pass

Mermaid companions should follow **validate before export / share**.

- syntax parses cleanly
- participant / state / relation declaration order matches intent
- arrow style stays internally consistent
- labels with special characters are quoted if needed
- subgraph / boundary / layer names are not over-compressed
- the rendered SVG can be used in fresh-viewer testing

Even if a future workflow imports Mermaid into the whiteboard, assume the Mermaid grammar must be stable first.

## Family Notes

### Flowchart

Good for:
- process / pipeline / service topology that should stay text-first
- cases where direction and subgraph already carry enough meaning

Guidelines:
- choose `LR` or `TD` first
- use subgraphs for layers / zones / subsystems
- preserve shape semantics for decision, database, start/end, and similar nodes
- use edge labels so branch conditions and handoffs are not lost

### Sequence

Good for:
- API flow, auth flow, async handoff, retry, or branching

Guidelines:
- make participant order explicit and keep the left-to-right reading stable
- do not mix request / response / async arrow grammar casually
- if `alt`, `opt`, `loop`, or `par` matters, prefer the grammar over adding ad hoc boxes
- if notes are needed, decide whether they belong in Mermaid or on the whiteboard

### State / ER / C4 / Timeline

Good for:
- state transitions, schema relations, architecture levels, or chronology

Guidelines:
- make transition / relation / chronology the canonical grammar
- let the whiteboard add overview, comparison, risk, and migration commentary
- do not mix context / container / component / deployment inside one C4 artifact

## Import Implications

If Mermaid import into the whiteboard grows later, it should not just flatten text into boxes.
At minimum, import should preserve:

- participant order
- node shape intent
- subgraph / boundary grouping
- edge labels and edge style
- direction (`LR`, `TD`)

Those semantics should survive in the imported shell.
