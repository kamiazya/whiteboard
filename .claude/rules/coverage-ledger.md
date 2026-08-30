---
paths:
  - "apps/web/**"
  - "packages/*/src/**"
---

# Coverage Ledgers

A ledger answers exactly one question: **when someone adds member N+1 to a
surface, does anything force them to notice the test that models it?**

Without one the answer is no, and the failure is silent in the worst way —
the suite reports the same number of passing cases it did yesterday, over a
surface that grew. Nothing is red. The `editor-state.property.test.ts` model
covered ten `EditorCommand` kinds and would have kept passing at twenty.

The mechanism is a map from the surface's own type to how the test treats
each member:

```ts
const VERB_COVERAGE = {
  bold: 'covered',
  link: 'not modelled: opens a picker; the dialog is a component, covered by link-picker.browser.test.tsx',
} satisfies Record<MarkdownVerbId, SurfaceCoverage>
```

`assertLedger` / `emptyTally` / `SurfaceCoverage` live in
`apps/web/src/test-utils/coverage-ledger.ts`. Do not re-implement them per
file — the four-direction logic and the wording of its messages are the
whole value, and a second copy drifts from the first.

## When a surface earns one

All three, not any one:

1. **It grows.** New members arrive as ordinary feature work. An editor's
   command set, its gesture events, its keyboard catalog, its editing verbs.
   A closed vocabulary (`ThemeMode`, `StateDotTone`) does not qualify — it
   is not going to gain a member, so nothing can forget it.
2. **Something models it.** A ledger tallies what a run PRODUCED. With no
   property, model, or table-driven test underneath, there is nothing to
   tally and the ledger degrades into a hand-maintained list of names — the
   thing it was supposed to replace.
3. **A missed member would be silent.** If forgetting one already fails a
   typecheck, a route table, or an exhaustive `switch`, that is a better
   guard than this and you are done.

## When it does not

- **The surface is not declared anywhere.** You cannot pin what is not
  written down; see the next section.
- **The members are uniform and independent.** Fourteen of the canvas
  ledger's entries are single-field inspector writes that touch neither
  gesture nor selection state, and all fourteen say so. That is the ledger
  working, not failing — but a surface where EVERY member is like that
  earns a note, not a table.
- **Coverage as a number.** A ledger is not a percentage and must never be
  read as one. `not modelled: <reason>` is a first-class, permanent answer.
  What it forbids is the un-decided member, not the uncovered one.

## The order: declare, model, pin

A ledger is the third step, and reaching for it first is the common mistake.
The spatial editor got one easily because its surfaces were ALREADY closed
unions (`EditorCommand['kind']`, `GestureEvent['type']`, `ShortcutId`). Most
screens are not like that: the markdown editor's verbs were an inline array
inside a `useMemo`, with `Mod-b` and the catalog's Bold row each carrying
their own `'**'` — two hand-kept lists, nothing but a reader stopping them
drifting.

So:

1. **Declare the surface** in one place — a union plus a table, exported.
   Both consumers derive from it. This step usually pays for itself before
   any test is written; extracting `MARKDOWN_EDITOR_VERBS` deleted a
   duplicated delimiter set and made the catalog's separators derived rather
   than positional.
2. **Model it** — a property over the members, or a table-driven test that
   drives each one. This is what the ledger will tally.
3. **Pin it** with the ledger.

Keep the table free of anything a plain node test cannot import. Icons and
JSX belong at the render site, keyed by id with its own
`satisfies Record<Id, ReactNode>` — which buys a second exhaustiveness guard
for free.

## The four directions

All four, or it decays into decoration. Two come from the type system, two
from `assertLedger` at runtime:

| # | direction | what fails | caught by |
|---|---|---|---|
| 1 | a new union member | missing property | `satisfies` |
| 2 | an entry naming a member that no longer exists | excess property | `satisfies` |
| 3 | `covered`, but the run never produced it | the claim is a lie | `assertLedger` |
| 4 | `not modelled`, but the run DID produce it | the entry is stale | `assertLedger` |

`not modelled` takes a reason, for the same purpose `blastRadius: none:`
does — a bare exemption is the omission with a word in front of it.

Runtime assertions go in `afterAll`. Note vitest reports an `afterAll`
failure as a failed SUITE while the summary line still reads "N passed" —
**the exit code is the truth.**

## The variant for a surface with no union

React state, a set of files, anything the type system does not enumerate:
scan the source instead, same both-sides contract.
`editor-state-surface.test.ts` is the worked example — `import.meta.glob`
with `?raw`, never `node:fs` (apps/web is browser-only and
`web-app-boundary.test.ts` enforces it).

Assert the scan found a plausible COUNT in its own `it`. A regex that stops
matching otherwise reports itself as "every entry is stale", which sends the
reader to the wrong file entirely.

There are two scans now, and they still do NOT share a helper. What they
have in common is four lines — the `?raw` glob and the plausible-count
assertion — and past that they diverge completely: `editor-state-surface`
CLASSIFIES each thing it finds against a three-value vocabulary it needs a
`view only:` state for, while `destructive-copy-surface` asserts a
single-definition rule and has no vocabulary at all. A helper over that is
a glob with a parameter. Extract when two call sites want the same
JUDGEMENT, not when two of them read files.

### The second one: copy declared once

`lib/destructive-copy.ts` + `destructive-copy-surface.test.ts` is the worked
example for a surface that earns a scan and explicitly does NOT earn a
ledger. Nothing models confirmation copy — there is no property or
table-driven run to tally — so a ledger would be the hand-maintained list of
names this rule exists to replace. Step 1 of declare -> model -> pin, plus a
scan holding it, is the whole mechanism, and that is a complete answer
rather than a partial one.

Two things it measured that generalise:

- **Scan word RUNS, not whole strings.** The defect that motivated it was a
  correction that had to reach six places and a grep that found four; both
  misses were tests asserting a MIDDLE FRAGMENT of the sentence. Measured:
  the first version of that scan compared whole fragments and flagged the
  three production sites and neither test. Five-word runs, derived from the
  copy by splitting on a sentinel subject, catch both. Four collides with
  ordinary English; six misses the prefix case.
- **Derive the probes, never list them.** A hand-picked "distinctive
  phrase" beside the copy is one more string to keep in step — the same
  defect one level up.

A scan has a floor and saying so is part of the rule: a test asserting a
three-word prefix is under any run length that avoids false positives. That
is acceptable here because the single definition removes the SWEEP rather
than perfecting the grep — with one source there is nothing to keep in
step, and a stale assertion fails loudly instead of being missed quietly.

## Traps

Each of these cost a real defect or a wrong conclusion.

- **A tally counts ATTEMPTS; that is not the same as exercising anything.**
  Keep a separate effects counter and assert it separately. A verb the run
  drove 24 times and never made change anything has asserted nothing,
  however green the properties look. Measured: the canvas model's `reorders`
  counter passed on 16 attempts and 2 real effects until the generator was
  made denser.
- **The fix for a vacuous property is a denser generator, never fewer
  assertions and never a pinned seed.**
- **Mutation-check the ledger itself, in all four directions.** A guard that
  cannot fail reads exactly like a guard that checked.
- **Apply the mutations SIMULTANEOUSLY when more than one path reaches the
  subject.** Removing a verb from one property while another still drives it
  proves nothing — and comes back green, which reads as "the ledger is
  broken" when the experiment was.
- **An offset is not a caret.** Any invariant applied twice across an edit
  has to re-derive its position from the new document. A demote shortens a
  line by one, and re-using the same number silently walks onto the next
  line — which is what H1's first counterexample turned out to be, not a bug
  in the code under test.
