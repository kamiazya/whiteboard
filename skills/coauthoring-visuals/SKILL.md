---
name: coauthoring-visuals
description: Evolve a whiteboard diagram collaboratively through structured context gathering, iterative refinement, and fresh-viewer testing. Use when a diagram feels misunderstood, under-explained, or needs tightening together with the user.
---

# coauthoring-visuals

This skill is not a drawing API reference.
`drawing-visuals` is the toolbox for how to draw.
`coauthoring-visuals` is the workflow for what to ask, in what order, how to tighten the result, and how to break it from a fresh viewer's perspective.

Open [`references/workflow-map.md`](./references/workflow-map.md) first and decide which stage you are entering.

- For canvas operations and diagram recipes, see [`../drawing-visuals/SKILL.md`](../drawing-visuals/SKILL.md)
- For a quick visual-direction pass, see [`references/visual-direction.md`](./references/visual-direction.md)
- For depth and visual-argument judgment in technical diagrams, see [`references/visual-argument.md`](./references/visual-argument.md)
- For selecting diagram family / viewpoint / layout, see [`references/diagram-family-selection.md`](./references/diagram-family-selection.md)
- For splitting whiteboard vs companion artifact, see [`references/surface-selection.md`](./references/surface-selection.md)
- For `whiteboard + mermaid` and its canonical-source / validation-first workflow, see [`references/mermaid-companion-patterns.md`](./references/mermaid-companion-patterns.md)
- For narrative / pacing after choosing slides, see [`references/slide-deck-patterns.md`](./references/slide-deck-patterns.md)
- For role-based shape / color / edge consistency in technical diagrams, see [`references/technical-role-profiles.md`](./references/technical-role-profiles.md)
- For overlap / clipped label / edge-collision cleanup after rendering, see [`references/geometry-checks.md`](./references/geometry-checks.md)
- For prompt entry points, see [`references/prompt-templates.md`](./references/prompt-templates.md)

## When To Use It

- "I want to tighten this diagram together" or "let's evolve the whiteboard as we talk"
- the requirements or main claim are not stable yet, and thinking-by-drawing is the right move
- a diagram already exists, but the questions it should answer need to be restructured
- you want to verify that the result still reads for someone seeing it cold

## Stage 1: Context Gathering

Before drawing, gather context **in batches, not one question at a time**.
The opening request should collect these ten things together:

- audience: who the diagram is for
- 5-second takeaway: what should remain after 5 seconds
- delivery surface: whiteboard only, or hybrid with mermaid / table / memo / slides
- depth: whether simple/conceptual is enough or comprehensive/technical is needed
- diagram family: decomposition, layered architecture, workflow/swimlane, trust-boundary, cloud/network zone, comparison split, or pipeline
- constraints: hard constraints, forbidden expressions, required document count
- source material: specs, screenshots, existing diagrams, URLs, bullet notes
- unknowns: unsettled points, in-flight discussion, unresolved claims
- job-to-be-done: what decision or comparison the diagram should support
- visual direction: whether it should feel calm, review-heavy, brand-aligned, dense, sparse, and so on

At this stage, welcome an unordered info dump.
Prompt the user to provide all fragments first: bullets, rough notes, images, links.
From that, extract:

- candidate sections, one per question the diagram must answer
- facts that belong on the board vs facts that can be omitted
- hypotheses that should not yet be presented as settled
- gaps that must be filled before drawing
- visual cues that must stay consistent across the whole document
- sections that should include concrete examples or evidence artifacts
- the first diagram grammar to try, and the points it cannot explain alone
- detail that should stay off-canvas

Do not get trapped in narrow back-and-forth questioning.
Bundle follow-up questions so they are only as detailed as needed to choose the whiteboard shell.
Treat subtle tone or brand cues as a **foundation**, not as rigid style law.
Translate them into space, form, color, and composition.
For technical diagrams, decide early **what concrete examples to show**, not just what generic labels to use.
If the diagram family is unclear, stop before fully drawing and decide what grammar should organize the material.
If the content really wants to become a structured table, such as a comparison matrix or long audit, do not force whiteboard-only.

## Stage 2: Refinement & Structure

The working unit is a **section** — one coherent question and its answer — not necessarily a whole
document. The whiteboard MCP surface has no frame/membership feature and no section-level render, so
a section is either its own document (`wb_document_create`), or a loosely bounded region within one
document marked with a `group` node (label + background only — it tracks no membership and cannot be
exported on its own).

Default rule: 1 section = 1 question.
Use this loop:

1. clarify: state in one sentence what this section answers
2. brainstorm: generate 2-3 candidate node / edge compositions
3. curate: choose one and explicitly name what you are discarding
4. gap check: find meaning that still exists only in your head
5. draw/update: one `wb_canvas_edit` call carrying the whole composition as ops
6. refine: tighten labels, alignment, and reading direction

Stage 2 rules:

- Fix the first conclusion each section should deliver
- First confirm that the **surface** is correct
  - whiteboard: structure, causality, boundaries, handoffs
  - whiteboard + mermaid: when structured grammar should stay diffable / versioned; Mermaid is canonical and should be validated before sharing
  - companion table/page: dense comparison, audit, inventory
  - slide deck: only when presentation is explicitly requested; decide one slide = one claim and pacing before building it
- Choose **one primary diagram family per section**
  - decomposition / mind map
  - layered architecture
  - workflow / swimlane
  - trust-boundary / security
  - cloud / network zone
  - comparison split
  - pipeline / roadmap
- In technical architecture / infra / workflow, choose a **semantic role profile**
  - gateway
  - service
  - queue / bus
  - database / store
  - external
  - security / auth
  - error / failure sink
  - decision
  - container / boundary
  - keep the same role aligned in color intent within the section
- Check whether the section works as a **visual argument**, not just a display
  - if text disappears, does the structure still preserve the gist?
  - does the viewer learn one concrete thing?
- Before drawing, define a short **mini visual philosophy** for the section or document
  - dominant color family
  - text density
  - where emphasis should live
- Generate options, then **curate before drawing**. Do not merge every candidate idea into one board
- Do not mix grammars too casually. If multiple grammars are needed, split sections or name one as primary and one as supporting
- Do not confuse simple/conceptual with comprehensive/technical
  - simple: optimize for shared mental model and relationship clarity
  - comprehensive: show actual events, payloads, method names, sample input/output, and similar specifics
- Do not overstuff detail into the whiteboard
  - overview belongs on the canvas
  - dense tables, long lists, and code-heavy detail belong in a companion artifact
- When fixing an existing document, prefer local surgery — `node.patch` / `edge.patch` / `node.remove` ops — over a full redraw
- Build complex sections from the shell outward
  - layout / reading direction
  - large-scale shell such as layer, lane, zone, boundary
  - node contents
  - edges and detail
- Within the same section, keep recurring node / edge vocabulary consistent
- Use family-specific semantic grouping
  - architecture: layer / subgroup / KPI row
  - workflow: pool / lane / step
  - security: trust boundary / access flow / audit flow
  - cloud/network: region / VPC / subnet / zone / physical vs logical link
- Technical diagrams should include evidence artifacts
  - real data format
  - real event / API / method name
  - sample input/output
  - if needed, short code / UI mock / timeline
- Do not put everything in boxes. Section titles, annotations, and supporting notes are often clearer as free-floating text nodes
- Use enough text to make the diagram readable, but do not let paragraphs do all the explanatory work
- If a comparison with 4+ rows or 3+ columns is the real subject, prefer a table surface over a diagram
- In large technical diagrams, think in multiple zoom levels
  - summary flow
  - section boundary
  - detail / evidence
- Fix the reading direction in flow-like diagrams
  - usually left-to-right
  - layer stacks top-to-bottom
  - comparisons with stable symmetry
- Split `current / problem / proposal` and `before / after` into separate sections
- Do not hide unknowns. Leave them visible as `unknown`, `assumption`, or `TBD`
- If your instinct is "add more," first see whether spacing, alignment, contrast, or repetition solves it more cleanly

## Stage 3: Fresh-Viewer Testing

Once a draft exists, break it as if you know nothing about the prior chat.
Review either the whole document or one section at a time, but do it **while looking at the SVG
`wb_scene_render` returns** (or, when you cannot view an image, what
`wb_canvas_snapshot({ layout: true })` returns).

Check:

- can the main subject be understood in 5 seconds?
- is the reading order across sections natural?
- do edges and boundaries explain themselves from the diagram alone?
- do important nodes say both what they are and why they are there?
- does the diagram pre-answer the questions a viewer is likely to ask?
- in technical diagrams, are concrete examples visible instead of only generic labels?
- would the hierarchy survive if unnecessary containers were removed?
- has the semantic role profile stayed consistent?
  - do gateway / service / queue / database / external keep stable appearances?
  - do dashed / accent / danger avoid carrying more than one meaning? (note: JSON Canvas edges have
    no dash/line-style field, so "different meaning" has to come from color or label, not stroke style)
- does the chosen diagram family fit the viewer's question?
  - is a responsibility problem accidentally shown as a workflow?
  - is a handoff problem being forced into a layer diagram?
  - is a trust-boundary problem missing zones entirely?
- is whiteboard even the right surface?
  - does reading detail require too much zoom?
  - would a table be faster for the information shown?
- are geometry failures still present?
  - overlap
  - clipped labels (there is no auto-wrap, so this is common)
  - dangling edges / edges pointing at the wrong node
  - edges through unrelated nodes
  - parallel edges collapsing into one visible path
  - stray nodes left far from the rest unintentionally

When needed, use the prompts in [`references/review-prompts.md`](./references/review-prompts.md) for fresh-viewer review, geometry QA, and question generation.
Open [`references/question-bank.md`](./references/question-bank.md) when you need question seeds.
Open [`references/visual-argument.md`](./references/visual-argument.md) when deciding between conceptual and technical treatment.
Open [`references/diagram-family-selection.md`](./references/diagram-family-selection.md) when the family is still unclear.
Open [`references/surface-selection.md`](./references/surface-selection.md) when the surface feels wrong.
Open [`references/technical-role-profiles.md`](./references/technical-role-profiles.md) when technical roles are drifting.
Open [`references/geometry-checks.md`](./references/geometry-checks.md) when the geometry needs repair.

If the fresh-viewer test surfaces ambiguity, return to Stage 2.
Do not over-explain by dumping more text.
Prefer **local whiteboard surgery** — `node.patch` / `edge.patch` / `node.remove` ops in one `wb_canvas_edit` call — over redrawing everything.
At this stage, prioritize the **second polish pass** over adding more nodes:
composition, whitespace, alignment, and label density should get tighter before the board gets bigger.

## Quality Gate

Before calling it done, meet this minimum bar:

- a fresh viewer can identify the audience and takeaway within 5 seconds
- each section has one stable question and one stable conclusion
- important edges and boundaries are labeled
- no essential meaning lives only in the chat context
- the structure remains readable even without decoration
- visual hierarchy and text density feel intentional, not accreted
- in technical diagrams, the viewer can take away concrete detail rather than generic node names
- the diagram family is clear section by section, and boundary / lane / layer / zone meaning is consistent
- in technical sections, the semantic role profile remains consistent
- no obvious geometry failures remain in the rendered SVG
- detail density matches the chosen surface

## References

- [`references/workflow-map.md`](./references/workflow-map.md): stage entry points and when to go back
- [`references/visual-direction.md`](./references/visual-direction.md): mini design philosophy and polish pass
- [`references/visual-argument.md`](./references/visual-argument.md): simple vs comprehensive, evidence artifacts, container judgment
- [`references/diagram-family-selection.md`](./references/diagram-family-selection.md): choosing viewpoint, layout, and semantic grouping
- [`references/surface-selection.md`](./references/surface-selection.md): splitting work across whiteboard / table / memo / slides
- [`references/mermaid-companion-patterns.md`](./references/mermaid-companion-patterns.md): canonical source / validation / family-specific Mermaid use
- [`references/slide-deck-patterns.md`](./references/slide-deck-patterns.md): narrative and pacing after choosing slides
- [`references/technical-role-profiles.md`](./references/technical-role-profiles.md): role profiles and visual consistency in technical diagrams
- [`references/geometry-checks.md`](./references/geometry-checks.md): post-render geometry QA and local fixes
- [`references/prompt-templates.md`](./references/prompt-templates.md): prompt index
- [`references/selection-prompts.md`](./references/selection-prompts.md): Stage 1-2 selection prompts
- [`references/review-prompts.md`](./references/review-prompts.md): Stage 3 review prompts
- [`references/question-bank.md`](./references/question-bank.md): question seeds for architecture / review / workflow / security / infra
