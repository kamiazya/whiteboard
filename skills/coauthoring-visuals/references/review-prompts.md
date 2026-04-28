# Review Prompts

Prompt set for Stage 3, where the goal is to break the diagram and see whether it still reads.

## Quick Map

- Fresh-Viewer Testing Prompt: first-view review
- Geometry QA Prompt: look only for visual breakage
- Viewer Question Generation Prompt: surface the questions the board will trigger
- Architecture Readability Prompt: review architecture-like diagrams with a rubric

## Fresh-Viewer Testing Prompt

Use this after exporting the diagram to PNG.

```text
You are a fresh viewer. You do not know the prior chat.

Audience:
5-second takeaway:
What the diagram is supposed to help decide:
Known constraints:

Review this exported whiteboard / frame only.

Tasks:
1. In one sentence, say what you think this diagram is about.
2. In one sentence, say what would stick after a 5-second glance.
3. List the parts that are ambiguous, overloaded, or missing labels.
4. List the questions a skeptical viewer would ask next.
5. Point out where icons, screenshots, or color seem to carry meaning without enough text or structure.
6. For technical diagrams, point out where concrete examples or evidence artifacts are missing.
7. Point out any containers that could become free-floating text without losing clarity.
8. Point out where the chosen diagram family seems mismatched to the question being answered.
9. Point out where the chosen surface seems mismatched to the information density.
10. Recommend the smallest edits that would make this easier to read.
11. Assess readability:
   - edge crossings
   - visual hierarchy
   - flow direction consistency
   - grouping effectiveness
   - relationship traceability
   - abstraction level consistency

Output format:
- inferred takeaway
- confusion points
- viewer questions
- missing evidence
- removable containers
- family mismatch
- surface mismatch
- readability assessment
- smallest useful edits
```

## Geometry QA Prompt

Use this when the issue is geometry, not meaning.

```text
Review this exported whiteboard / frame for geometry issues only.

Tasks:
1. list overlaps
2. list clipped or cramped labels
3. list arrows or connectors that do not visually connect cleanly
4. list edges that pass through unrelated boxes
5. list parallel edges that collapse into one visible path
6. list stray elements that look detached from the intended frame
7. recommend the smallest local edits to fix each issue

Rules:
- Focus on visible geometry problems, not missing content.
- Prefer local surgery over full redraw.
- If an issue is really a shell problem, say so explicitly.

Output format:
- overlaps
- clipped labels
- connection issues
- edge collisions
- stray elements
- smallest useful fixes
```

## Viewer Question Generation Prompt

Use this before editing when you want to surface the questions careful viewers will ask.

```text
Generate the questions a careful viewer would ask after seeing this whiteboard.

Context:
- audience:
- intended takeaway:
- diagram type: architecture / review-comparison / infrastructure / other

Rules:
- Ask questions that arise from the image alone, not from hidden chat context.
- Prefer questions that expose missing labels, unclear ownership, weak comparison axes, or invisible assumptions.
- Group similar questions and keep only the sharpest wording.
- After the questions, add a short note for each one: "already answered", "partly answered", or "not answered in the diagram".

Return:
1. top 5 viewer questions
2. why each question appears
3. the smallest diagram edit that would answer it
```

## Architecture Readability Prompt

Use this when you want a rubric-driven review of an architecture / C4 / system-landscape diagram.

```text
Review this architecture diagram for readability and abstraction discipline.

Context:
- audience:
- intended takeaway:
- intended abstraction level: context / container / component / deployment / unknown

Tasks:
1. count or estimate meaningful edge crossings
2. say whether the main system boundary or focal structure is visually prominent enough
3. identify the primary reading direction and whether it stays consistent
4. check whether related elements are grouped closely enough to read as one unit
5. check whether relationships can be traced without confusion
6. check whether the diagram mixes abstraction levels
7. recommend the smallest edits that would improve readability without changing the core story

Return:
- crossings
- visual hierarchy
- flow direction
- grouping
- traceability
- abstraction level
- smallest useful edits
```
