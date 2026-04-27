# Workflow Map

If you are unsure which stage to enter, start here.

| Situation | Starting Stage | What To Do | Next |
| --- | --- | --- | --- |
| No diagram exists yet, or the issues are still scattered | Stage 1: Context Gathering | Gather audience, 5-second takeaway, delivery surface, depth, diagram family, constraints, source material, unknowns, and visual direction in one batch. If needed, decide whether `whiteboard + mermaid` or slide deck is the right surface. If Mermaid is chosen, define canonical source and validation pass via `mermaid-companion-patterns.md` | Stage 2 |
| A diagram exists, but the frame question or composition is weak | Stage 2: Refinement & Structure | Fix the question frame by frame. Decide surface, mini visual philosophy, visual argument, diagram family, and semantic role profile before redrawing | Repeat Stage 2 |
| The diagram exists, but you are not sure a fresh viewer can read it | Stage 3: Fresh-Viewer Testing | Review exported PNGs / frames for misreadings, weak evidence, excess containers, family mismatch, surface mismatch, and geometry failures; then run a second polish pass | Return to Stage 2 or finish |

## When To Go Back

- source material is thin and the frame is mostly hypothesis: return to Stage 1
- the diagram is technical but lacks real examples: return to Stage 1 and gather source material again
- the diagram family is wrong: return to Stage 1 and recut the question
- too much detail was forced into the whiteboard: return to Stage 1 and choose the surface again
- one frame contains more than one main claim: split it in Stage 2
- a fresh viewer cannot say what is being compared or what changes: return to Stage 2

## Minimal Loop

1. gather context in one batch
2. choose the delivery surface
   - whiteboard only / whiteboard + mermaid / whiteboard + table / memo-page / slides
   - if Mermaid is chosen, define canonical source and validation pass too
3. fix the frame question
4. choose the diagram family and reading direction
5. decide the depth and whether evidence is required
6. if technical, choose the semantic role profile
7. write a short visual direction
8. generate options
9. choose one
10. draw
11. export and break it with fresh-viewer and geometry passes
12. repeat 2-11 until it reads

## Division Of Labor

- `drawing-visuals`: drawing and canvas operations such as boxes, arrows, frames, export
- `coauthoring-visuals`: the collaboration workflow for building the visual
- `whiteboard-smoke` (for repo developers): post-change validation of skills and tools

If a slide deck is chosen, open [`./slide-deck-patterns.md`](./slide-deck-patterns.md) and confirm one-slide-one-claim plus pacing.
