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
    // 57 rather than 56 since the comment-body layout module (deleted with
    // the composer in S18h2), which the lane deliberately did NOT cover: what
    // it decided was which markdown theme a comment took and what a body that
    // would not parse degraded to, and both were pinned by named tests that
    // were mutation-checked by hand (swapping in the document theme failed
    // them with `expected 30 to be 24`). The rest was delegation to the
    // typesetter, which the lane then mutated.
    //
    // 58 since the task checkbox module (deleted with the typesetter in
    // S18h2), outside the lane for the same shape of reason: it was geometry
    // with no branch worth mutating beyond ticked-vs-not, and that one WAS
    // pinned by name — removing the
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
    // 60 and 11 since `ink/sketch.ts`, which the lane DOES cover: its
    // reach and determinism claims are properties, exactly what a survivor
    // would expose as decorative.
    //
    // 63 since `svg/paint.ts` and `svg/shapes.ts` left `svg/backend.ts`:
    // the paint helpers and the shape/edge renderers it had grown past its
    // line ceiling with. Not in the lane — their properties are the
    // byte-identical SVG tests, which are examples.
    // 61 since `ink/glow.ts`: one arithmetic line pinned by
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
    // 66 and 12 since the TypeScript diagonal clip, the straight style's
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
    // Still 67 with the contributed-router module, which arrived in the same
    // increment that moved `scene-graph.ts` out: one module in, one out.
    // The router is outside the lane, because every
    // branch it has is a way of DECLINING — no contribution claims the edge,
    // the name is one nobody registered, the router answers `null`, the path
    // is under two points, an endpoint is missing — and each falls back to
    // the built-in, which its own test pinned by name. A
    // survivor there would say a fallback is unobserved, and the fallbacks
    // are the whole module.
    // 68 and 13 with the tidy's units half in the lane (since gone, below).
    // 70 after two files arrived from opposite directions, both OUTSIDE the
    // lane and each for its own reason.
    //
    // the TypeScript bend route (the model-and-format ADR's bends slice):
    // its branches are ways of declining, or of picking one of four borders,
    // each pinned by name in the bend route's own test. Nothing in it is a
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
    // 73 since the wrapper's line-break seam was split in two, and the two
    // went opposite ways. The inline-junction rule went IN, for the reason
    // its own entry gave: a rule whose every decision is mutation-shaped,
    // not a ladder of ways to decline. The UAX #14 segmenter stayed OUT — it
    // was the `LineBreaker` call plus the code-point to UTF-16 offset walk
    // that sliced each segment (pinned by a differential property against the
    // library's own `Break.slice()`), there only so the wrapper's granularity
    // ladder and the junction rule could not come to disagree about where a
    // line may break. Both were deleted with the typesetter in S18h2.
    // 76 since the legend (ADR-0040 decision 6), all three modules outside
    // the lane. `legend/legend-geometry.ts` is constants and the panel's row
    // list, pinned by the band tests' exact viewBox numbers — a survivor
    // there is a different constant, which those numbers refuse.
    // The legend's computation (deleted with the composer in S18h2) was a
    // reading OFF the facet score — which keys it listed and which swatch
    // each class got — pinned by examples that planted one board each (a carried key, an uncarried
    // colour, a frame that carries and is not listed, an edge key), the
    // same shape as the instruments it reads. `svg/legend.ts` is document
    // chrome whose every decision is a coordinate, pinned by the backend's
    // byte-level examples; a survivor there would be a legend two pixels
    // over, which no reader could call a defect.
    // 77 since colour by intent (ADR-0040 decision 5), and 15 mutated:
    // `tags/declared-colours.ts` is IN, because its three properties share
    // nothing with it — own colour preserved, coloured iff exactly one
    // colour is declared, idempotent and colour-only — and each of its
    // decisions (the contested case, the identity return, the edge branch)
    // is mutation-shaped.
    // 81 since `spatial-canvas.ts` gave its overlay layers and its options
    // vocabulary their own modules (task #84). Four files, no new behaviour
    // and none in the lane: the comment and proposal layers were the moved
    // bodies, covered by `comments.test.ts` and `proposals.test.ts` through
    // the same entry point as before; `layout-options.ts` is type
    // declarations plus one zod union, so there is nothing in it to mutate;
    // the scene-extent module was the two-line extent the two overlays were
    // each computing with the same `Math.max(0, ...)` pair. The layers and
    // the extent went with the composer in S18h2.
    // 82 and 16 since the TypeScript min-heap came out of the TypeScript grid router (the A*
    // priority queue, forty lines of index arithmetic that could not be
    // tested where it sat). It is IN the lane rather than merely counted:
    // its two properties are stated from what a min-heap means, not from
    // the sift, and both were mutation-checked by hand when written —
    // inverting the sift-up comparison fails three cases, re-rooting with
    // the wrong value fails one.
    // 83 since `svg/render-edge.ts` left `svg/backend.ts` — the edge's path
    // data, its arrow markers and their assembly, moved when naming the four
    // biggest `renderNode` cases carried that file past the 800-line budget
    // again. Outside the lane for the same reason `svg/paint.ts` and
    // `svg/shapes.ts` were when they left the same file: what pins this code
    // is the byte-identical SVG tests, which are examples, so a mutation
    // report over it would be survivors nobody can act on. Held instead by a
    // differential over 24 scenes and 14 single-leaf ones, mutation-checked
    // by hand at the three cases that moved — flattening preserveAspectRatio,
    // dropping the glyph baseline offset, and dropping the fragment's
    // presentation role each move the dump.
    // 85 and 18 with the tidy's axis and band modules in the lane (since gone, below).
    //
    // 86 and 19 since the TypeScript ink terms came out of the TypeScript edge rules the same way
    // — the ink TERMS — and is in the lane for the same reason.
    //
    // 87 and 19 since the node composer came out of `spatial-canvas.ts`
    // — how one node's box is drawn and filled, 47% of that file. OUTSIDE the
    // lane, because the file it left was: splitting it changes nothing the
    // lane saw, which is the opposite case from the TypeScript ink terms. What pins it is the scene and SVG suites, which are
    // examples, so a mutation report over it would be survivors nobody can
    // act on — the reasoning `svg/paint.ts` left under.
    //
    // 88 and 19 since `layout/canvas-theme.ts` came out of it too — which
    // theme a canvas is drawn in — outside the lane for the same reason.
    //
    // 90 and 19 with `references/wire-schema.ts` and `theme/theme-font.ts`:
    // two Zod contracts the MCP Apps widget and `canvas_view` both read,
    // placed here because this is the one package both reach. Outside the
    // lane: a schema and a two-line projection either way have no heuristic
    // in them for a mutant to weaken, and the example tests beside them say
    // exactly what they admit.
    //
    // 93 and 19 since the typesetter's block module gave up its code block,
    // its table and the vocabulary both shared with it to modules of their
    // own. Outside the lane, because the file they left was: the typesetter
    // was pinned by the text-wrapping scoreboard and its example suites,
    // which were the reason it was never in the lane, and a split moved none
    // of that. The options module was types and three font constants
    // besides. All four went with the typesetter in S18h2.
    //
    // 96 and 19 since the TypeScript side-choice search gave up its side
    // vocabulary, its anchor pass and its router into modules of their own,
    // keeping the search. Outside the lane for
    // the reason the file they left was: what pins the router and the side
    // choice is the routing scoreboard, which re-runs per mutant at ~22s and
    // is excluded from the lane on price, and the example suites beside it.
    //
    // 95 since the embed-recursion module was deleted: a bundle walk whose
    // only caller was its own property test, while the embed contract it
    // stated is pinned where the content is laid out (decision 4).
    //
    // 96 with `references/resolved.ts`: the three types a reference seam
    // answers, moved out of the layout modules so the seams' producer does
    // not import the layout. Outside the lane — interfaces only, nothing for
    // a mutant to change.
    //
    // 97 and 20 with `quality/rect.ts`: the overlap and containment
    // arithmetic the digest (then in the lane) shared with the quality
    // instruments, so it is in the lane too.
    //
    // 98 with `scoring.ts`, the `/scoring` subpath: re-exports of the three
    // quality instruments, outside the lane for the reason they are.
    //
    // 97 since the highlight folder's one-line barrel was deleted: a
    // re-export nothing imported, outside the lane for the reason a barrel is.
    //
    // 99 since the node composer gave up its box primitives and a file
    // node's representations to modules of their own. Outside the lane for
    // the reason the file they left was: the scene and SVG example suites
    // pinned them, and a split moved none of that. All three went with the
    // composer in S18h2.
    //
    // 100 since `finite-box.ts` became the one definition of a box with
    // finite sides, which three SVG leaves and two layout leaves each spelled
    // for themselves. A predicate the painting suites pin at every call.
    //
    // 101 since the TypeScript route-end records: the record types the router's
    // two path builders take, so their ten positional parameters cannot be
    // handed over in the wrong order. Types only, nothing to mutate.
    //
    // 102 with `highlight/code-token.ts`: the tokeniser's output types, moved
    // below `layout/` so the tokeniser does not import a layout module. Types
    // only, nothing to mutate.
    //
    // 103 and 21 with `xml-escape.ts`, the escaping half of `svg/format.ts`,
    // moved to the package root so `layout/` and `svg/` can both import it.
    // IN the lane, because the file it left was: the move changes nothing the
    // lane saw.
    //
    // 104 and 22 with `scene-children.ts`, `sceneChildrenOf` lifted out of
    // `scene-bounds.ts` so a layout stage below it reads the one definition;
    // in the lane for the same reason.
    //
    // 105 with `hit-test.ts`, the one rule for which node a click lands on,
    // shared by the editor and the MCP Apps widget. Outside the lane: its own
    // example suite pins each branch and a surviving mutant would show there.
    //
    // 107 with `svg/document-href.ts`, the one decoder of a scene's document
    // link beside its encoder, and `theme/spatial-theme-mode.ts`, the mode
    // schema on its own so a type-only reader does not pull the theme layer.
    // Outside the lane: the decoder's table test pins every branch, and the
    // schema is a two-member enum.
    //
    // 108 with the embed budget, the nested-layout budget every embed spent
    // from. Outside the lane: a counter whose budget test pinned both the
    // bound and that the excess still drew.
    //
    // 109 and 23 with the longest-fit search, the prefix search lifted out of
    // the truncation's cut loop; in the lane because that file was.
    //
    // 110 with the loose-occurrence finder, the whitespace-loose passage
    // search lifted out of the passage highlight. Outside the lane, as that
    // file was: a property against the regex it replaced pinned every span,
    // and its overlap, squash and end-offset branches were mutation-checked
    // by hand against it.
    //
    // 111 with the line-jump narrow phase, lifted out of the line jumps so
    // its cost test could count calls. Outside the lane, as that file was:
    // the line-jump tests pinned its three rejection branches — a hit outside
    // either segment, one too close to an end for the arc, and a non-finite
    // hit point.
    //
    // (The embed budget, the longest-fit search, the truncation, the loose-
    // occurrence finder and the passage highlight went with the typesetter in
    // S18h2; the line jumps and their narrow phase in S18h3.)
    //
    // 112 with the TypeScript routing budget, the per-layout account the
    // grid router and the side-choice search spend from. Outside the lane,
    // as the embed budget was: it holds two constants and a constructor, and
    // the checks that spend it live in the TypeScript grid router and
    // the TypeScript crossing sweep, which are in it.
    //
    // 113 with `svg/filter-budget.ts`, the summed filter-region bound. Outside
    // the lane, as the rest of `svg/` is: `filter-region-budget.test.ts`
    // reads the sum off the SVG with its own parser, and its budget, shadow
    // weight, raster scale, clip, largest-first order and definition removal
    // were each mutation-checked by hand against it.
    //
    // 114 with the tokeniser budget, the per-layout tokeniser account every
    // fence the default highlighter coloured spent from. Outside the lane, as
    // the embed budget was: a constructor and one spend, whose highlight
    // budget test pinned both accounts, the refusal count a cache read, and a
    // fresh account per layout — each mutation-checked by hand against it.
    // The core keeps the account now; the module went in S18h3.
    //
    // 115 with `references/content-budget.ts`, one reference walk's account
    // of the characters and canvas elements it loads. Outside the lane, as
    // the embed budget was: two constants and an account whose refusal,
    // closing and node-text charge `content-budget.test.ts` pins, and whose
    // use by the daemon's loader `canvas-view.cost.test.ts` counts — each
    // mutation-checked by hand against them.
    //
    // 116 with the loading-embed placeholder, the framed "Loading…" a block
    // embed draws while its target is still being fetched, and the "Empty
    // canvas" line a canvas embed with nothing on it draws. Outside the lane:
    // three guards and one small layout, each pinned by example in its own
    // test and reached from the browser by
    // `embed-loading-preview.browser.test.tsx`; nothing in it was a cost
    // model or a search a survivor could hide in. It went with the
    // typesetter in S18h2, and the core draws the placeholder now.
    //
    // 117 with `theme/text-halo.ts`, the one constant for a haloed run's
    // pad, read by the painter and by `sceneBounds` so the pill it draws is
    // counted in the viewBox. Outside the lane: a constant with no branch,
    // pinned by `scene-bounds.test.ts`'s haloed-run case and mutated by hand
    // to 0 against it.
    //
    // 118 with the TypeScript contact mark, the contact mark two touching
    // boxes are drawn as instead of a route. Outside the lane: a predicate
    // and one small geometry, pinned by example and by a property over
    // touching pairs in `edge-touching-boxes.rust.test.ts`, its guards each
    // mutated by hand against them; nothing in it is a cost model or a search.
    //
    // 119 with `stroke-weight.ts` (then under `layout/`), the multiple of the theme's
    // line weight a stroke's named weight draws at. Outside the lane: a
    // three-entry table and one product, pinned through the TypeScript
    // layout by a stroke-weight test and mutated by hand against it (the call
    // removed, the factor changed). Since S18h2 the core applies the weight
    // and the test went with the layout it drove; the table stays for the
    // editor's draft under the pen.
    //
    // 120 and 24 with the TypeScript corner search, the straight
    // style's corner search, which the lane DOES cover: it is a search, and
    // the corner search's property suite states its oracle from the
    // definition rather than from the code — checked by hand against three
    // mutations (the escape test, a corner's clearance, a skipped obstacle)
    // before the lane took it. Its `MINUTES` figure is an estimate until a
    // weekly run measures it (`stryker-targets.mjs` says how).
    //
    // 122 with two modules split out of files the lane does not mutate
    // either, to keep them under the size budget: the TypeScript side slides
    // (moving a route's end along its side, from the TypeScript edge router) and
    // the TypeScript coincident-ends repair (scoring a repaired pair, from
    // the TypeScript side-choice search). Same code, same tests, same answer as before.
    //
    // 123 with the TypeScript around ledger, the side search's record of
    // which stepping-round choices it priced, split out of the TypeScript side-choice search
    // (which the lane does not mutate) under the size budget. Outside the
    // lane for the same reason: its two recordings and its drop are each
    // pinned by an example in `edge-straight-detour.rust.test.ts` and mutated by
    // hand against them.
    // 124 with the legend scene, a board's legend as scene nodes for a
    // canvas embedded in a note. Outside the lane: a row walk with no cost
    // model or search, pinned by its embedded-legend test (rows, unscaled
    // size, place inside the frame, swatch colours) and mutated by hand
    // against it. Both went with the composer in S18h2.
    // 123 without the contributed-router module: the edge-router
    // contribution seam had no consumer but its own test, and edge routing
    // is this package's alone. It was outside the lane, so the reach is
    // unchanged.
    // 124 with `layout/fitted-height.ts`, the one fitted text-node height the
    // editor and wb_canvas_edit both call. Outside the lane: two readings, a
    // max and the padding, each pinned by name in `fitted-height.test.ts`
    // (the floor binding, the caller's font binding) and by a parity test at
    // each call site.
    // 25 of 125 with `det-math.ts`, the pinned hypot/sin/cos layout calls
    // (ADR-0054 decision 11), in the lane because its oracle is a bit-exact
    // table of the Rust libm crate's answers.
    // 126 with `generated/geometry.zod.ts`, the Point and Rect `cargo xtask
    // codegen` emits from contracts/geometry. Outside the lane: it is
    // generated, so an edit to it fails `codegen --check` before any test,
    // and its refusals are pinned by `geometry-contract.test.ts`.
    // 127 with the routing seam (ADR-0054), then a two-way dispatch: the
    // core when a root handed one, else the TypeScript routing. Outside the
    // lane: both branches were driven by its own test. The TypeScript branch
    // went with the TypeScript routing (S18h3b); the seam is `layout-core.ts`.
    // 128 with the phrase-pair rule: the join of a BudouX phrase that ends
    // inside a surrogate pair, outside the lane because it was one loop whose
    // every branch its surrogate-pair test drove. Both went with the
    // typesetter in S18h2.
    // 130 with `canvas-core.ts` (types alone) and `layout/canvas-switch.ts`,
    // the whole layout's dispatch to the core. Outside the lane for the routing
    // seam's reason: a dispatch and a request built from options,
    // every branch driven by `layout/canvas-switch.test.ts`. It stays: since
    // S18h2 it is the request each option becomes, with no TypeScript behind it.
    // 132 with `fragment-ask.ts` (a schema and one key) and the fragment
    // table module, rendered math and diagrams as a table. Outside the lane
    // for the same reason: one wrapper and the switch's handling of what it
    // asked, every branch driven by the table's own test and mutation-checked
    // by hand. The table module and its test went in S18h2, when the core
    // became the only reader of a table.
    // 134 with `hit-boxes.ts`, the box half of `hit-test.ts` split out with no
    // import so the MCP Apps widget can read it, and
    // `picture/canvas-view-picture.ts`, the widget's picture contract (a schema
    // and one call into `topmostHit`). Outside the lane as `hit-test.ts` is:
    // `hit-test.test.ts` and the widget's picture tests pin every branch.
    // 136 with `markdown-core.ts` (types alone) and `layout/markdown-switch.ts`,
    // a markdown note's dispatch to the core. Outside the lane for the canvas
    // dispatch's reason: a dispatch and a request built from options,
    // every branch driven by `layout/markdown-switch.test.ts` and
    // mutation-checked by hand. It stays, as the canvas switch does.
    // 139 with `query-core.ts` (types alone), `layout/query-switch.ts` (the
    // queries' switch) and `layout/queries.ts` (the editors' geometry through
    // it). Outside the lane for the same reason: every branch driven by
    // `layout/query-switch.test.ts` and mutation-checked by hand.
    // 140 with `refusal.ts` (S18f), the words a refused layout is drawn with
    // and the one box that draws them. Outside the lane for the same reason:
    // every branch driven by `refusal.test.ts` and the switches' tests, and
    // mutation-checked by hand.
    // 143 with three modules moved out of `layout/` ahead of its deletion
    // (S18h1): the TypeScript edge rules' containment predicate and
    // `comment-geometry.ts` (`nearestPointOnPolyline` out of
    // the comment-bubble placement, with `commentAnchor` and the bubble constants)
    // join the lane, since both files they left were in it and leaving them
    // out would shrink what it sees; `paint-order.ts` (`paintOrderOf`, out of
    // `spatial-canvas.ts`, which never was) stays outside, its three branches
    // driven by `paint-order.test.ts`.
    // 111 and 23 since the TypeScript composer and typesetter were deleted
    // (S18h2): the layout is the Rust core's, so `layout/` keeps only the
    // request builders and queries over it, and the four mutated modules that
    // went with it (the truncation, the longest-fit search, the
    // inline-junction rule and the comment-bubble placement) are the Rust
    // ports' to hold now, by cargo-mutants over the frozen recordings.
    // Nothing that remained left the lane.
    // 107 since the dead exports they left were deleted (S18h3): the
    // tokeniser budget, the line jumps, the edge-label placement, and the
    // line-jump narrow phase, which moved to `test-utils/wasm/` as the
    // reference its Rust port is held to. None was in the lane.
    // 88 and 16 since the TypeScript edge routing was deleted (S18h3b): the
    // twenty-one modules and the bench under `layout/edges/` went, and three
    // root modules took what outlives them — `edge-routing.ts` (the sides,
    // anchors and budget a caller hands the core), `layout-core.ts` (the core
    // as a root hands it, and `routeLayout`, one call into it) and
    // `stroke-weight.ts`, the stroke-weight table, moved as it stood. None of the three joins the lane:
    // types, a constant table and a one-line forward, with nothing a mutant
    // could change that a test could see. The seven mutated routing modules
    // (the cost model, the ink terms, the diagonal clip, the crossing sweep,
    // the grid router, its heap and the corner search) are the Rust ports' to
    // hold now, by cargo-mutants over the frozen recording.
    // 88 and 15 since the digest moved to the core: the derivations and
    // their mutation residue are the Rust port's to hold, by cargo-mutants over
    // the frozen recording. `scene-digest-schema.ts` took its Zod contract and
    // stays outside the lane: a schema has no heuristic for a mutant to weaken.
    // 85 and 11 since tidy moved (84 and 10 with its last helper, the containment predicate, gone with it) to the core: the passes and their mutation
    // residue are the Rust port's to hold, by cargo-mutants over the frozen
    // recording, and `tidy.ts` kept the boxes a canvas gives it and the one
    // adapter call, which leaves nothing for a mutant to weaken that a test
    // could not see.
    // 85 and 10 with `core-picture.ts` (ADR-0054 A2), a server picture's one
    // core call: an envelope handed through and a refusal drawn by the
    // backend, held byte for byte by `core-picture.rust.test.ts`, which is the
    // stronger check; nothing in it is a heuristic for a mutant to weaken.
    expect({ mutated: MUTATED.length, production: production.length }).toEqual({
      mutated: 10,
      production: 85,
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
    // rewrite a condition in the TypeScript crossing sweep and its entries match no
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
    expect(MUTATED).not.toContain('src/ink/seed.ts')
  })
})
