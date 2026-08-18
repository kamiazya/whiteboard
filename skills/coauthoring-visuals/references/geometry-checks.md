# Geometry Checks

Fix **geometry failures separately from meaning failures** after rendering. There is no automated
overlap or overflow warning on this tool surface — the check is entirely visual, against the SVG
`wb_scene_render` returns.

## What To Check After Rendering

- overlap: nodes, labels, and edges do not collide
- clipped label: text is not cut off inside a node (there is no auto-wrap, so this is common)
- dangling connection: an edge does not visually touch its node, or appears to connect to the wrong side
- edge-through-node: an edge passes through an unrelated node
- stacked parallel edges: multiple edges visually collapse into one path
- stray element: something is left far from the rest of the diagram unintentionally
- off-balance shell: the shell is correct, but one side is visibly overcrowded

## Order Of Fixes

1. clipped / overlap
2. dangling connection
3. edge collision
4. stray element
5. spacing / alignment polish

Do not spend time polishing a diagram whose meaning is still weak.
But if the meaning is already solid, geometry failures are usually the fastest thing to fix first.

## Local Surgery

- overlap: widen the gap, shift one node down a row, or shorten the label — a `node.patch` op (or
  just a `tidy` op, which separates overlaps for you)
- clipped label: widen the node (`width`/`height`) or shorten the text
- dangling connection: `edge.patch` the `fromSide`/`toSide` hint, or nudge the node it targets
- edge-through-node: move the intervening node aside, since edges have no manual routing points to bend around it
- stacked parallel edges: offset the nodes vertically, or demote one edge into a side path
- stray element: `node.remove` it if it should not be there, or `node.patch` it back near the rest
  of the diagram if it should
- shell collapse: before rebuilding the shell, re-fix only the outer boundary and reading direction

## Smells

- small collisions remain that only become obvious after rendering
- there is no warning mechanism, so a label crammed against its neighbor is silent until you look at the SVG
- edge collision draws more attention than the main path
- two parallel paths exist, but only one is visible

## Reminder

Geometry QA is not a replacement for fresh-viewer testing.

- geometry QA: remove visible visual breakage
- fresh-viewer test: find meaning breakage
