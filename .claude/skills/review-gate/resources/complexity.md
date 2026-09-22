# Complexity

`noExcessiveCognitiveComplexity` is on (threshold in `biome.json`), and the
files that still exceed it sit on a shrink-only exemption list
(`tools/arch-lint/src/complexity-exemptions.test.ts`). Those rungs catch the
NUMBER. This lane asks the question the number cannot: when a diff makes code
harder to follow, is there a STRUCTURE that removes the difficulty — rather
than an exemption, or a helper that carries the same branches somewhere else?

It is default, not opt-in, for the reason `reachability` and `background-work`
are: complex code is CORRECT code. It passes its tests and does what it
should, so no other lane has a reason to look, and by the time the lint rule
fires the shape is already set.

## Measure first

```
node .claude/scripts/complexity-of.mjs --base origin/main --changed
```

scores every function the diff touched, at the base and at the head, exempt
files included, without editing `biome.json` or anything else in the tree. `!`
is over the threshold, `~` within three of it. A function that moved to
another file is joined to its old self and reads `(from <file>)`, so an
extracted module shows as a move rather than as new code. Quote those
numbers in a finding. Never measure by editing `biome.json` in the tree under review.

## Criteria

### 1. The exemption list does not grow without an architectural answer

Check:
- Does the diff add a path to the `noExcessiveCognitiveComplexity` override's
  negations in `biome.json`, or raise `EXEMPT_COUNT`? A function moved into an
  exempt file, or pushed over the threshold inside one, is the same thing with
  less noise.
- If so, does the diff or PR body name the structural alternative considered
  and why it was not taken? "It moved unchanged" is acceptable only with a
  named follow-up that pays it down; a bare "the file was already exempt" is
  a finding.

### 2. Rising complexity is answered by structure, not relocation

Check each function whose score rose, or that scores near or over the
threshold, against these shapes — each has a precedent here:

| the code has | the structure that removes it | precedent |
|---|---|---|
| a branch per KIND of a closed union | a `satisfies Record<Kind, Handler>` table — the union growing becomes a type error | `COMPOSE_BY_KIND`, `layout/compose-node.ts` |
| a chain of "try this, else that" early returns | a list in rank order; the first that answers wins | `FILE_REPRESENTATIONS`, same file |
| the same logic written twice for two symmetric cases (x/y, from/to, before/after) | one operation over an abstraction of the case | `tidy-axis.ts` |
| boolean flags that combine into states | a discriminated union of the states | — |
| one function doing two jobs (resolve then apply, decide then perform) | a boundary between them, often a module | `layout/layout-options.ts` beside the composer |

A finding is a function that fits a shape and did not take its structure. It
is ALSO a finding when complexity was "reduced" by extracting helpers that
move the same branches into new functions without removing any — the total is
unchanged and the reader now follows it across more places.

### 3. Near the threshold is worth a sentence

Check:
- A function the diff touched scoring within three of the threshold: a LOW
  note naming the shape it fits, if one does. Not a finding by itself — it is
  what the next change to that function will push over.

## Not this lane's

- **Removing code.** Whether something needs to exist, or can be one line, is
  the `simplifier` agent's `ponytail` ladder. This lane is about SHAPE.
- **Mixing a restructure into a move.** A behaviour-preserving move is easiest
  to review with its bodies byte-identical. Recommend the structural follow-up
  as a separate change; do not demand it inside the move.
- **Complexity that has been earned and recorded.** Package rules and audit
  documents list algorithms whose complexity is the point (a search, a cost
  model, a gesture reducer's exhaustive switch). Read the rule for the package
  before raising one of those.
- **`notApplicable`** when the diff changes no TypeScript logic — docs,
  configuration, fixtures.
