# Geometry Checks

Another useful idea borrowed from `drawio-skill` is to fix **geometry failures separately from meaning failures** after export.

## What To Check After Export

- overlap: boxes, labels, arrows, and notes do not collide
- clipped label: text is not cut off inside a box or frame
- dangling connection: an arrow does not visually touch its box, or appears to connect to the wrong edge
- edge-through-box: an arrow passes through an unrelated box
- stacked parallel edges: multiple edges visually collapse into one path
- stray element: something is left outside the frame or far away unintentionally
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

- overlap: widen the gap, shift one element down a row, or shorten the label
- clipped label: widen the box, add height, or split content into `title` and `subText`
- dangling connection: move start/end closer to the intended target or shift the box slightly
- edge-through-box: reroute with polyline / curve or widen the lane / zone
- stacked parallel edges: offset anchors, separate paths vertically, or demote one into a side path
- stray element: move it back into the frame or delete it if unnecessary
- shell collapse: before rebuilding the shell, re-fix only the outer boundary and reading direction

## Smells

- Small collisions remain that only become obvious after export
- `annotate_batch` shows no warning, but the PNG still has labels that are hard to read
- Edge collision draws more attention than the main path
- Two parallel paths exist, but only one is visible

## Reminder

Geometry QA is not a replacement for fresh-viewer testing.

- geometry QA: remove visible visual breakage
- fresh-viewer test: find meaning breakage
