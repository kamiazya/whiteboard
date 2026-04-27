# Selection Prompts

Prompt set for Stage 1-2, where the goal is to choose what to draw and in what form.

## Quick Map

- Mini Visual Philosophy Prompt: visual direction
- Depth And Evidence Prompt: conceptual vs technical
- Technical Role Profile Prompt: role-based appearance
- Surface Selection Prompt: whether whiteboard is enough
- Mermaid Companion Prompt: what must be fixed if Mermaid is the companion
- Diagram Family Selection Prompt: choose the grammar

## Mini Visual Philosophy Prompt

Use this when you want to define visual direction in four short lines before drawing.

```text
Create a mini visual philosophy for this collaborative whiteboard.

Context:
- audience:
- 5-second takeaway:
- diagram type:
- source material:
- constraints:

Return:
1. a 1-3 word direction name
2. dominant color family
3. shape language
4. text density
5. composition rhythm
6. one warning about what would make the board feel noisy or inconsistent

Rules:
- This is not poster art. Optimize for diagram clarity first.
- Use space, form, color, and composition to create tone.
- Keep the direction specific enough to guide the canvas, but short enough to preserve freedom while drawing.
```

## Depth And Evidence Prompt

Use this when you need to decide whether a conceptual treatment is enough or whether technical detail is required.

```text
Assess the required depth for this whiteboard.

Context:
- audience:
- 5-second takeaway:
- what the diagram should help decide:
- source material:

Return:
1. choose one: simple/conceptual or comprehensive/technical
2. explain why
3. if technical, list the concrete evidence artifacts the diagram should include
4. if technical, list the facts that must be researched or confirmed before drawing
5. list the risks of staying too abstract

Rules:
- Prefer concrete examples when the viewer needs to learn how the system actually works.
- Do not recommend evidence artifacts that are decorative only.
```

## Technical Role Profile Prompt

Use this when you want consistent role treatment inside a technical frame.

```text
Choose a semantic role profile for this technical whiteboard frame.

Context:
- audience:
- 5-second takeaway:
- diagram family:
- what the frame should help decide:
- source material:

Return:
1. which roles are actually present in this frame
2. for each role, the visual treatment to keep consistent
   - shape family
   - color intent
   - edge treatment
   - preferred label style
3. which roles can share the same base silhouette
4. which roles must stay visually distinct
5. the main consistency failure to avoid

Rules:
- Optimize for comprehension, not visual variety.
- Do not create a separate shape just because a role has a different name.
- Keep dashed treatment to one meaning per frame.
```

## Surface Selection Prompt

Use this when deciding whether whiteboard alone is the right surface.

```text
Choose the right delivery surface for this explanation.

Context:
- audience:
- 5-second takeaway:
- what the artifact should help decide:
- source material:
- expected level of detail:

Return:
1. choose one: whiteboard only / whiteboard + mermaid / whiteboard + table / whiteboard + memo-page / slides
2. explain why
3. what belongs on the canvas
4. what should stay off-canvas
5. the main failure mode if we force everything into the wrong surface

Rules:
- Prefer whiteboard for structure, causality, boundaries, and handoffs.
- Prefer Mermaid as a companion when the canonical artifact should stay text-based, diffable, or version-controlled.
- Prefer table/page surfaces for dense comparison, audits, inventories, and code-heavy detail.
- Choose slides only when presentation is explicitly requested.
- If slides are chosen, optimize for narrative order and one-slide-one-claim, not for dumping the whole whiteboard onto slides.
```

## Mermaid Companion Prompt

Use this when `whiteboard + mermaid` has been selected and you need to lock down Mermaid's role.

```text
Plan the Mermaid companion artifact for this collaborative whiteboard.

Context:
- audience:
- 5-second takeaway:
- what the artifact should help decide:
- source material:
- chosen diagram family:

Return:
1. choose one Mermaid family for the canonical artifact
2. explain why Mermaid should be the source-of-truth instead of whiteboard alone
3. what belongs in Mermaid vs what belongs on the whiteboard
4. which ordering or grammar must be explicit
   - participants
   - states
   - subgraphs / boundaries
   - edge labels / arrow meaning
5. what must be validated before export or import
6. the main failure mode if we blur the two artifacts together

Rules:
- Optimize for stable grammar, not decorative detail.
- Prefer Mermaid when auto-layout and diffability are more valuable than manual placement.
- Keep whiteboard responsible for framing, commentary, comparison, and callouts.
```

## Diagram Family Selection Prompt

Use this when you need to choose the grammar itself.

```text
Choose the best diagram family for this collaborative whiteboard.

Context:
- audience:
- 5-second takeaway:
- what the diagram should help decide:
- source material:
- known constraints:

Return:
1. primary diagram family
2. one backup family
3. recommended reading direction
4. the semantic groupings to use (for example: layers, lanes, trust boundaries, zones, sidebars)
5. what should be shown in the main frame vs sidebars vs separate frames
6. what would become confusing if we chose the wrong family

Rules:
- Prefer one primary family per frame.
- If multiple families are needed, explain how to split them across frames.
- Optimize for viewer comprehension, not tool convenience.
```
