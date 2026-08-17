# Decomposition And Trees

In decomposition and tree diagrams, handle **the same kind of question at the same depth**.

## Good Fits

- topic breakdown
- option tree
- taxonomy
- separating pros / cons
- structuring the discussion before moving into architecture

## Shell

- Start with one root
- Keep level-1 branches to 2-5 items
- Preserve the same classification axis at the same depth
- In bilateral comparisons, keep left and right meanings fixed

## Reading Direction

- Keep the tree either top-to-bottom or left-to-right
- In bilateral layouts, assign stable meaning to left and right
- Do not change direction branch by branch

## Labels

- root: the main claim or question
- branch: a short noun phrase along the classification axis
- leaf: a concrete example, decision input, or exception
- In decision trees, keep branch labels aligned as `YES / NO + condition`

## Hard Rules

- Do not mix chronology into a decomposition diagram
- Do not let parent and child levels drift too far apart in granularity
- Do not mix unrelated categories such as actor / data / policy at the same depth
- If lines would cross, split the work into separate frames

## Common Failures

- The root is so broad that level 1 becomes a catch-all
- Children are longer and heavier than their parent
- The tree turns into a comparison or flow diagram halfway through
- The classification axis and evaluation axis are mixed into the same branch

## Local Surgery

- If a branch is too wide: split it into two levels
- If the same term repeats in many leaves: promote it one level up
- If exceptions break the tree: move them into a dedicated frame
- If pros / cons muddy the tree: split into a bilateral frame

## If Stuck

- For structural framing, see [`./flow-and-architecture.md`](./flow-and-architecture.md)
- If the branching is really conditional logic, see [`./sequence-and-decisions.md`](./sequence-and-decisions.md)
