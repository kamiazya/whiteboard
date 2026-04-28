# Comparison Splits

In comparison splits, **keep the comparison axis aligned and emphasize only the differences**.

## Good Fits

- `current / problem / proposal`
- before / after
- option A / option B
- migration comparison
- side-by-side comparison for a review artifact

## Shell

- Limit the comparison to 2-3 dimensions
- Arrange columns or frames in a mirrored layout
- Use the same anchors in each column / frame
- Put the conclusion in the frame name or the first large text block

## Reading Direction

- Usually left-to-right
- For `current -> problem -> proposal`, preserve time order
- In A/B comparisons, keep the left/right meaning fixed
- Fix the comparison axis to one direction only

## Labels

- State the comparison axis explicitly
- Prioritize `name + role` in each box and push evaluative language into `subText`
- Add callouts only where there is an actual difference
- Keep arrow labels to a small number

## Hard Rules

- Do not vary the composition too much across the compared targets
- Do not mix the problem and the proposal into the same annotation
- Do not rename the same kind of box with different wording in each column
- Do not add decorative differences where no actual difference exists
- Do not mix unrelated flows into a comparison frame

## Common Failures

- The axes drift between before and after
- Only the `problem` frame carries too much information
- Too many callouts bury the actual comparison
- The box grammar changes by column, forcing relearning instead of comparison

## Local Surgery

- If the axis drifts: align anchor box position and size
- If one side is too dense: move detail into a side note
- If the claim is weak: put the conclusion first in the frame title or opening text
- If the differences are scattered: narrow hotspots / callouts to 1-2 places

## If Stuck

- For broad guidance, see [`./review-and-comparison.md`](./review-and-comparison.md)
- For tree-like pros/cons, see [`./decomposition-and-trees.md`](./decomposition-and-trees.md)
