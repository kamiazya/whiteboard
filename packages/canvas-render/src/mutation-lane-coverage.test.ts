import { describe, expect, it } from 'vitest'
import { KNOWN_EQUIVALENT, MUTATED } from '../stryker-targets.mjs'

/**
 * The mutation lane covers a LIST of modules, not the package, and a list's
 * failure mode is silence: a module added next month is simply not covered,
 * the weekly report still looks healthy, and nothing anywhere says the lane
 * has been looking at less and less of the code.
 *
 * So both halves are pinned EXACTLY — the same instrument shape as this
 * package's quality scoreboards, where an improvement is as loud as a
 * regression. Adding a production source file fails this test until someone
 * decides IN THE DIFF whether the lane should cover it; the answer may well be
 * "no", and then the count moves and the decision is on the record.
 *
 * Deliberately not "every file must be listed": mutating all 47 of them is
 * 9089 mutants, several hours at this package's measured rate, so the lane's
 * scope is a budget. This test does not argue with the budget. It only makes
 * spending it a choice rather than an oversight.
 */
const sources = import.meta.glob('./**/*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

/** Production sources: not tests, and not the fixtures/arbitraries they share. */
function isProductionSource(path: string): boolean {
  return !path.includes('.test.') && !path.startsWith('./test-utils/')
}

const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * The original halves a `KNOWN_EQUIVALENT` key could be split into.
 *
 * A key is `Mutator: <original> -> <replacement>` and BOTH halves may contain
 * a literal ` -> ` of their own — an arrow function is the obvious case — so
 * there is no split that is right by construction. Every candidate is returned
 * and the caller accepts the entry if any of them is in the file. That is
 * deliberately permissive in the ambiguous case and exact in the one that
 * matters: when the expression is gone from the file, no split matches.
 */
function originalsOf(key: string): readonly string[] {
  const body = key.replace(/^[A-Za-z]+: /, '')
  const splits: string[] = []
  for (let at = body.indexOf(' -> '); at !== -1; at = body.indexOf(' -> ', at + 1)) {
    splits.push(body.slice(0, at))
  }
  return splits
}

describe('the mutation lane covers what it says it covers', () => {
  const production = Object.keys(sources).filter(isProductionSource).sort()

  it('scans a package worth scanning', () => {
    // The guard above is worthless if the glob ever stops matching: an empty
    // scan agrees with every count.
    expect(production.length).toBeGreaterThan(30)
  })

  it('names exactly the modules it mutates, out of exactly this many', () => {
    // 57 rather than 56 since `layout/comment-body.ts`, and the lane
    // deliberately does NOT cover it: what that module decides is which
    // markdown theme a comment takes and what a body that will not parse
    // degrades to, and both are pinned by named tests that were
    // mutation-checked by hand (swapping in the document theme fails them
    // with `expected 30 to be 24`). The rest is delegation to
    // `layoutMdastBlocks`, which the lane already mutates.
    //
    // 58 since `layout/nodes/task-checkbox.ts`, and outside the lane for the
    // same shape of reason: it is geometry with no branch worth mutating
    // beyond ticked-vs-not, and that one IS pinned by name — removing the
    // filled rect fails `fills the box for a ticked item` and returning no
    // marker at all fails the preview guard in apps/web. What a mutation
    // score would add here is a number over two rects.
    //
    // 59 since `theme/theme-asset.ts`, outside the lane: it is a field-by-
    // field copy of the token contract onto the palette plus a memo, and both
    // are pinned by name — the round-trip test fails on any dropped field and
    // the memo test on a fresh object per call. A mutation score would count
    // 30 property copies.
    //
    // 60 and 11 since `layout/ink/sketch.ts`, which the lane DOES cover: its
    // reach and determinism claims are properties, exactly what a survivor
    // would expose as decorative.
    //
    // 63 since `svg/paint.ts` and `svg/shapes.ts` left `svg/backend.ts`:
    // the paint helpers and the shape/edge renderers it had grown past its
    // line ceiling with. Not in the lane — their properties are the
    // byte-identical SVG tests, which are examples.
    // 61 since `layout/ink/glow.ts`: one arithmetic line pinned by
    // `glow.test.ts`'s bounds assertion, which fails on any other reach.
    //
    // 62 since `scene-graph.ts` LEFT this package for `@kamiazya/whiteboard-
    // scene`. Nothing about the lane changed: the file was types only, so it
    // was never mutable and never in it — a module count moving without the
    // mutated set moving is what an extraction of pure types looks like.
    // 64 since `quality/drawing-score.ts`, outside the lane: an instrument,
    // calibrated by examples that plant one defect each and read exactly one
    // — the shape a mutation run would report as unsurprising survivors —
    // and checked by hand once, four metrics mutated and six of its cases
    // failing.
    // 65 since `quality/polyline-geometry.ts`, the geometry the drawing score
    // and the scoreboards' oracles share, outside the lane for the reason
    // the oracles are: what pins it is the scoreboards it feeds, whose
    // exact numbers move on any change to it.
    // 66 and 12 since `layout/edges/diagonal-ink.ts`, the straight style's
    // chord through an edge's own box, which the lane DOES cover: its
    // sampled oracle and invariants are properties, and a survivor would be
    // a chord read wrong.
    // 67 since `quality/composition-score.ts`, outside the lane for the
    // reason `drawing-score.ts` is: an instrument whose calibration plants
    // one defect and reads one column, which a mutation run reports as
    // unsurprising survivors. Hand-checked instead — three predicates
    // mutated (the apart threshold, the shared-line minimum, the gap's
    // axis), and the first survived, which is how the tie case came to be
    // pinned.
    //
    // Still 67 with `layout/contributed-router.ts`, which arrived in the same
    // increment that moved `scene-graph.ts` out: one module in, one out.
    // The router is outside the lane, because every
    // branch it has is a way of DECLINING — no contribution claims the edge,
    // the name is one nobody registered, the router answers `null`, the path
    // is under two points, an endpoint is missing — and each falls back to
    // the built-in, which `contributed-router.test.ts` pins by name. A
    // survivor there would say a fallback is unobserved, and the fallbacks
    // are the whole module.
    // 68 and 13 since `tidy-units.ts`, split out of `tidy.ts` when that file
    // passed the 800-line budget and covered for the same reason `tidy.ts`
    // is: the split moved `buildUnits` — where `tidy.ts`'s own survivors had
    // migrated — so leaving it out would have quietly reduced the lane's
    // reach while the report read the same.
    // 70 after two files arrived from opposite directions, both OUTSIDE the
    // lane and each for its own reason.
    //
    // `layout/edges/bend-route.ts` (the model-and-format ADR's bends slice):
    // its branches are ways of declining, or of picking one of four borders,
    // each pinned by name in `bend-route.test.ts`. Nothing in it is a
    // property that could be silently asserting nothing. If a stored path
    // ever grows a COST model — a bend that yields to an obstacle, say —
    // that answer changes.
    //
    // `quality/facet-score.ts`, for the reason `drawing-score.ts` and
    // `composition-score.ts` are: an instrument whose calibration plants one
    // defect and reads one column is exactly the shape a mutation run
    // reports as unsurprising survivors. Hand-checked instead, and the check
    // found two real defects rather than none — a treatment lookup keyed by
    // the node where an id was wanted, so every board read as spending
    // nothing, and overload and excess both firing on the same board because
    // they were tested independently.
    // 71 since `svg/icon.ts`, and OUTSIDE the lane. It is where `backend.ts`
    // kept the icon table, its two fallbacks and the one producer of a
    // `<use>` that references an icon, split out when a text run gained the
    // ability to paint one so the `icon` node and that run cannot emit
    // different definitions of the same icon. Nothing moved into it from a
    // lane module — `backend.ts` was never in the lane — so the reach did
    // not shrink. And it holds no property: every branch is a way of
    // declining (a non-finite box, a name the table lacks, a
    // prototype-inherited name answering a function) with a named example
    // apiece, plus construction the pixel goldens compare byte for byte.
    expect({ mutated: MUTATED.length, production: production.length }).toEqual({
      mutated: 13,
      production: 71,
    })
  })

  it('lists only files that exist, at their real paths', () => {
    // The other direction: a renamed or deleted module leaves an entry that
    // silently mutates nothing, which reads exactly like a covered file.
    const onDisk = new Set(production.map((path) => path.replace(/^\.\//, 'src/')))
    expect(MUTATED.filter((entry: string) => !onDisk.has(entry))).toEqual([])
  })

  it('records equivalents only for files the lane actually mutates', () => {
    // An entry for a file outside `MUTATED` suppresses nothing and reads as
    // triage that happened. The likely way to get one is renaming a module and
    // updating only the list above.
    const covered = new Set(MUTATED)
    expect(Object.keys(KNOWN_EQUIVALENT).filter((file) => !covered.has(file))).toEqual([])
  })

  it('records a positive count for every equivalent it names', () => {
    // A zero or negative count suppresses nothing while looking like it does,
    // which is the one way this ledger can quietly stop working.
    const bad = Object.entries(KNOWN_EQUIVALENT).flatMap(([file, mutants]) =>
      Object.entries(mutants)
        .filter(([, count]) => !Number.isInteger(count) || count < 1)
        .map(([key]) => `${file} :: ${key}`),
    )
    expect(bad).toEqual([])
  })

  it('names an expression that is still in the file it names', () => {
    // The way this ledger actually decays. The two guards above catch a moved
    // FILE; nothing catches a moved EXPRESSION, and that is the common edit —
    // rewrite a condition in `edge-crossing-sweep.ts` and its entries match no
    // mutant ever again, while the ledger goes on claiming 23 settled findings
    // and the report goes on being read as if they were still true.
    //
    // Same both-sides discipline as `arch-lint`'s allowlists: an entry cannot
    // outlive the thing it names. The check is a whitespace-flattened
    // substring, which is what `mutantKey` compares anyway — Stryker reports
    // the original slice from its own location, so an expression the file
    // still contains is present verbatim modulo indentation.
    const stale = Object.entries(KNOWN_EQUIVALENT).flatMap(([file, mutants]) => {
      const source = flatten(sources[file.replace(/^src\//, './')] ?? '')
      return Object.keys(mutants)
        .filter((key) => !originalsOf(key).some((original) => source.includes(original)))
        .map((key) => `${file} :: ${key}`)
    })
    expect(stale).toEqual([])
  })

  it('excludes seed.ts, whose survivors this tool reports falsely', () => {
    // Pinned rather than left to the comment beside it: this exclusion is the
    // one that would look like an oversight to the next reader, and re-adding
    // it puts known-wrong rows in front of an author.
    expect(MUTATED).not.toContain('src/layout/seed.ts')
  })
})
