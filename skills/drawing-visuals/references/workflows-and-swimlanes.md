# Workflows And Swimlanes

In workflow / swimlane diagrams, treat **who hands off to whom and where** as first-class information.

## Good Fits

- approval chains
- cross-team handoffs
- division of labor between user and system
- business flows that include sync / async behavior

## Shell

- Place lanes first
- Decide the start / end on the main lane
- Keep the main path straight
- Push messages / exceptions / retries to the same side off the main path

## Reading Direction

- Usually left-to-right
- Top-to-bottom is fine if you want it to read like an ordered list
- Minimize crossings for messages that span lanes

## Semantic Grouping

- lane: actor / role / system
- step: action
- gateway: condition
- dashed path: async / message / audit

## Hard Rules

- Do not put long paragraphs in lane titles
- Do not give one step more than one responsibility
- Push every decision NO path to the same side
- Do not overload the mainline with trivial retries
- Do not use dashed for both `async` and `optional`; keep one meaning per frame
- Do not force role decomposition and step flow into one frame if they fight each other

## Common Failures

- Lanes start representing phases instead of actors
- Every step has the same weight, so the handoff disappears
- Async paths cross the mainline repeatedly
- Exceptions multiply until the main path is unreadable

## Local Surgery

- If there are too many lanes: merge trivial roles
- If there are too many exceptions: create an exception-only frame
- If the handoff is buried: split the step at the lane boundary
- If stages and roles are mixed: split into a workflow frame and a layered frame

## If Stuck

- If it is closer to sequence or decision logic, see [`./sequence-and-decisions.md`](./sequence-and-decisions.md)
- If it is really about phase progression, see [`./pipelines-and-roadmaps.md`](./pipelines-and-roadmaps.md)
