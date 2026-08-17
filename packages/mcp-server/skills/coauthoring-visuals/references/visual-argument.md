# Visual Argument

The key idea is to treat a diagram not as a display of information, but as a **visual argument**.

## Two Tests

### Isomorphism Test

If you remove the text, does the high-level meaning still survive through structure alone?
If not, fix shape, grouping, and flow before adding more boxes.

### Education Test

Can the viewer learn one concrete thing from the diagram?
If the board only says `API`, `Database`, `Processor`, it is weak.
When needed, show actual event names, payloads, sample input/output, or method names.

## Depth Assessment

Before drawing, decide which of these is required:

- simple / conceptual:
  - mental model
  - role division
  - coarse relationships
- comprehensive / technical:
  - real connections
  - real data formats
  - real event / API / method names
  - enough specificity to revisit the diagram as a learning artifact

If the diagram is technical but you present it with only a simple surface, the viewer leaves with false confidence.

## Evidence Artifacts

In technical diagrams, include at least one of these when relevant:

- data / JSON example
- sample input / output
- real event or method names
- short code snippet
- short timeline
- UI mock or visible output

An artifact is not decoration. It is evidence that the diagram is grounded.

## Multi-Zoom

Large technical diagrams should not stop at a single explanatory layer.

- summary flow: the overall shape
- section boundary: the main grouping
- detail / evidence: concrete examples inside a section

When you split regions or documents, decide which of these levels each one is responsible for.

## Containers

Do not put everything in boxes.

- use containers for distinct things or connection targets
- consider free-floating text first for section titles, annotations, and supporting notes

Questions to ask:
- does the shape itself carry meaning?
- do you need arrows to connect to it?
- does it need grouping?
- would typography alone be enough?
