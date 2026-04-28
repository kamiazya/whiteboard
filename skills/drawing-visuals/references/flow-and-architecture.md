# Flow And Architecture

For structural and data-flow diagrams, decide first **what you want to lock down**.

If you need family-specific techniques:
- layered tiers: [`./layered-architectures.md`](./layered-architectures.md)
- decomposition / trees: [`./decomposition-and-trees.md`](./decomposition-and-trees.md)

- Show responsibility boundaries
- Make the viewer follow the main path
- Push external dependencies off to the side

## Basic Shell

- Keep the main flow to one path
- Fix the gaze either left/right or top/bottom
- Put only parallel elements from the same layer in the same row / column
- Push secondary elements to the right or below the main flow

## Abstraction Level

For architecture diagrams, fix **which abstraction level the diagram uses**.

- context: actors / external systems / boundary of the target system
- container: major runtime pieces, services, databases, queues
- component: internal modules or responsibility splits inside one container
- deployment: nodes, clusters, runtime placement

Do not mix these in one frame.
In particular, avoid showing too many internal components in a context diagram or dropping a container diagram all the way down to tables / fields / methods.

Recommended reading path:
- left: user / client / trigger
- center: gateway / API / service
- right: data / storage / external dependency

## Labels

- Center boxes on `name + role`
- Use short verbs on arrows
  - `calls`
  - `reads`
  - `writes`
  - `persists`
  - `broadcasts`
- Push long explanations into box `subText`

## Color

- `primary`: entrypoint / client
- `success`: service / compute
- `info`: metadata / side info
- `neutral`: external / structure

## Role Consistency

- client / trigger
- gateway / adapter
- service / worker
- store / database
- queue / bus
- external dependency

Use the same silhouette and color intent for the same role within one frame.
Optimize for recognizability of roles, not visual variety.

## Common Failures

- Mixing structural explanation with problem callouts or proposals
- Arrow labels drawing more attention than the boxes
- Mixing context / container / component / deployment in one frame
- Mixing actor / service / storage in the same layer
- Flattening gateway / service / queue / store into the same generic box

## If Stuck

- For recipes, see `Architecture / Data flow diagrams` in [`../style-reference.md`](../style-reference.md)
- For vocabulary, see `Show structure` and `Make the viewer follow the flow` in [`../visual-vocabulary.md`](../visual-vocabulary.md)
