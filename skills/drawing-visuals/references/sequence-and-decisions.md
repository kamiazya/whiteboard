# Sequence And Decisions

For chronological and branching diagrams, prioritize **not interrupting the viewer's gaze**.

If you need family-specific techniques:
- role / lane / handoff: [`./workflows-and-swimlanes.md`](./workflows-and-swimlanes.md)
- phase progression / rollout: [`./pipelines-and-roadmaps.md`](./pipelines-and-roadmaps.md)

## Sequence Diagrams

- Arrange actor headers horizontally
- Do not omit lifelines
- Keep messages horizontal
- Default to solid for requests and dashed for responses
- When placing text near an activation, push it to the side without overlap
- Let participants read as their roles; do not flatten boundaries / controls / queues / databases into generic actors

Good fits:
- request / response
- event sequence
- broadcast / sync

## Decision Trees / Branching

- Keep the YES path in the main column
- Push the NO path to the same side consistently
- Phrase decision nodes as questions
- Use color to distinguish terminal meanings

Good fits:
- fallback
- auth / validation
- retry / conflict handling

## Labels

- Use short labels that still reveal actor roles on sequence arrows
- Write decision branches as `YES / NO + condition`
- For sequence responses, say only what comes back instead of restating the request

## Common Failures

- Omitting lifelines
- Packing in too many actors so the lanes become cramped
- Styling request and response the same way
- Letting the NO path scatter in a different direction every time

## If Stuck

- For detailed recipes, see `Sequence diagrams` and `Decision tree / branching flow` in [`../style-reference.md`](../style-reference.md)
