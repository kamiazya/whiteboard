// The modules the mutation lane covers, in a plain module of their own so
// three consumers can read the same list without loading Stryker: the config,
// the PR scoping script, and the guard test that keeps this honest.
//
// It is a LIST rather than "the whole package", and that is a budget decision
// backed by a measurement: `MINUTES` below records what each listed module
// costs a run, and the list is a small share of the package's production
// files. What a list costs is that it goes stale silently — a module added
// next month is simply not covered and nothing says so — which is why
// `mutation-lane-coverage.test.ts` pins both this list and the package's
// production file count EXACTLY; read the counts there rather than copying
// them into prose, where they drift. Adding a module then fails that test
// until someone decides, in the diff, whether the lane should cover it.
//
// The diff-scoped PR run reads this list too, so a file's absence here means
// no PR feedback on it either. Weigh that when adding a module: a file with
// properties worth trusting belongs in the lane; one whose tests are examples
// only will report true-but-unsurprising survivors.
export const MUTATED = [
  // Colour by intent (ADR-0040 decision 5): three properties over random
  // boards and libraries, stated from the declaration rather than the code.
  'src/tags/declared-colours.ts',
  // Serialization: escaping and character legality, byte-identical output.
  'src/svg/format.ts',
  // The escaping half of the above, split out so `layout/` and `svg/` both
  // reach it without either importing the other. Still in the lane: leaving it
  // out would shrink what the lane sees of serialization.
  'src/xml-escape.ts',
  'src/svg/hoist.ts',
  // Pure geometry and derivation with properties of their own.
  'src/scene-bounds.ts',
  // How a scene nests, split out so a layout stage below `scene-bounds` reads
  // it too. In the lane because the file it left was.
  'src/scene-children.ts',
  // The rectangle arithmetic the quality instruments share: leaving it out
  // would shrink what the lane sees of them while the report kept looking the
  // same.
  'src/quality/rect.ts',
  // Moved out of the TypeScript comment-bubble placement (S18h1), then in the
  // lane, so leaving it out would have shrunk what it saw.
  'src/comment-geometry.ts',
  // The sketch ink decomposition: reach, determinism and translation
  // equivariance are properties over random boxes and seeds, and the
  // silhouette per outline kind is pinned by example.
  'src/ink/sketch.ts',
  // The pinned math layout calls instead of Math.hypot/sin/cos (ADR-0054
  // decision 11). Its oracle is independent and bit-exact — 900 answers of
  // the Rust libm crate — so a surviving mutant is a polynomial term or a
  // reduction round that answer never needed.
  'src/det-math.ts',
  // NOT `src/ink/seed.ts`, and the reason is a measurement rather than a
  // judgement about its value. Stryker selects the test files related to a
  // mutated module, and seed.ts is imported by its own test and nothing else:
  // 7 tests, against the 458 that cover `svg/format.ts`. Its runtime mutants
  // came back SURVIVED even when the same edit applied by hand failed the
  // suite — verified on `/ 4294967296` -> `* 4294967296`, which Stryker called
  // a survivor while `every draw is finite and in [0, 1)` goes red on it in a
  // plain `vitest run`. The cause was not the narrowness but the property's
  // title, which carries a fresh seed per process (`vitest.stryker-setup.ts`
  // pins it now; the decisions doc has the re-measurement, where that mutant
  // is Killed). The exclusion stands until the lane's pinned counts are
  // revisited on purpose: what survives there now is the FNV-1a arithmetic,
  // which no known vector pins.
]

/**
 * What each curated file costs the lane, in minutes of one runner's mutation
 * phase: the figure the legs are dealt by. Mutant COUNT does not predict it —
 * per mutant, the cost is the tests it runs, and that differs by two orders of
 * magnitude between files. Dealt by count, one run's six legs took 11 to 60
 * minutes: the grid router (the TypeScript grid router, deleted with the TypeScript
 * routing in S18h3b) was 303 mutants and 42 minutes, `sketch.ts` 473 and
 * under five.
 *
 * measured: 2026-10-05, weekly run 37303929216 (dealt by file count, six
 * legs). Each leg's log reports `N/M tested` every ten seconds, and Stryker
 * runs a leg's mutants in a known order — the ones its coverage maps to tests
 * first, then the STATIC ones (which run every test after a reload), each
 * group in id order, and ids follow file path order — so a file's minutes are
 * the stretch of the log in which its mutants were tested. Two consequences
 * for reading the figures: they resolve to about ten seconds, and a static
 * mutant's cost is every test the LEG selects, so a file's figure moves a
 * little with the company it is dealt into.
 *
 * A file added to `MUTATED` needs a figure before a leg can be dealt —
 * `shardOf` refuses one without. Until a run measures it, estimate from a file
 * of similar mutant count and the same tests, and say so beside it.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const MINUTES = {
  'src/tags/declared-colours.ts': 1.3,
  'src/svg/format.ts': 3.8,
  'src/xml-escape.ts': 6.8,
  'src/svg/hoist.ts': 2,
  'src/scene-bounds.ts': 12.3,
  'src/scene-children.ts': 0.8,
  'src/quality/rect.ts': 7.7,
  // ESTIMATED, not yet measured: a handful of mutants each.
  'src/comment-geometry.ts': 0.5,
  'src/ink/sketch.ts': 4.5,
  // ESTIMATED, not yet measured: about 120 mutants, one 5-test file that
  // runs in milliseconds.
  'src/det-math.ts': 1.5,
}

/**
 * The share of `files` one leg of a sharded run mutates, from a `k/n` spec
 * (1-based): `shardOf(MUTATED, '2/4')`. No spec means everything, which is
 * what a local `pnpm mutation:render` wants.
 *
 * Dealt by `minutes`, heaviest first, each file to the leg with the least so
 * far (ties to the earlier file and the lower leg), so the legs finish close
 * together and the heaviest leg — the one a timeout is sized from — is as
 * light as the files allow. A file heavier than a fair share ends up alone,
 * which is the best any deal can do with it. Every leg of a spec computes the
 * same deal, so the legs partition `files` exactly. The result keeps the
 * order of `files`.
 *
 * @param {readonly string[]} files
 * @param {string | undefined} spec
 * @param {Readonly<Record<string, number>>} [minutes]
 */
export function shardOf(files, spec, minutes = MINUTES) {
  if (spec === undefined || spec === '') return [...files]
  const match = /^(\d+)\/(\d+)$/.exec(spec)
  const shard = Number(match?.[1])
  const total = Number(match?.[2])
  if (match === null || shard < 1 || shard > total) {
    throw new Error(`shard spec must be "k/n" with 1 <= k <= n, got "${spec}"`)
  }
  const unmeasured = files.filter((file) => (minutes[file] ?? 0) <= 0)
  if (unmeasured.length > 0) {
    throw new Error(
      `no recorded minutes for ${unmeasured.join(', ')} — add a figure to MINUTES in stryker-targets.mjs`,
    )
  }
  const load = Array.from({ length: total }, () => 0)
  const legOf = new Map()
  const heaviestFirst = files
    .map((file, index) => ({ file, index }))
    .sort((a, b) => minutes[b.file] - minutes[a.file] || a.index - b.index)
  for (const { file } of heaviestFirst) {
    const lightest = load.indexOf(Math.min(...load))
    load[lightest] += minutes[file]
    legOf.set(file, lightest)
  }
  return files.filter((file) => legOf.get(file) === shard - 1)
}

/**
 * Survivors that NO test can kill, because the mutation does not change what
 * the code does. They are a real triage answer rather than debt, and without
 * somewhere to record them the same set is re-investigated every time the
 * lane runs — the TypeScript crossing sweep alone reports 23 of them on every
 * report, which is more than the PR comment's whole table holds, so one file's
 * settled findings would hide every other file's live one.
 *
 * An entry is a CEILING, not a mute: the count is how many of that exact
 * mutation were seen and shown to be equivalent, and the (N+1)th is reported
 * like any other survivor. The key names the original expression as well as
 * the replacement so it survives edits elsewhere in the file — a line number
 * would resurrect the whole list on the next unrelated commit — at the cost
 * that a genuinely new survivor of the SAME mutation on the SAME expression
 * hides until it exceeds the count.
 *
 * An entry cannot outlive what it names: `mutation-lane-coverage.test.ts`
 * fails on one whose file the lane no longer mutates, and equally on one
 * whose ORIGINAL EXPRESSION is no longer in that file. The second is how this
 * decays in practice — rewrite a condition here and its entries match no
 * mutant ever again, while the ledger goes on claiming the findings are
 * settled. The third case a source scan cannot reach — the expression is still
 * there but a test now KILLS the mutation, so the entry asserts something
 * false — is reported by the sticky comment, which lists the recorded
 * equivalents a run did not produce. It is a prompt rather than a failure,
 * because an entry can go missing to the same noise floor as a score.
 *
 * Nothing here is taken on trust: each was verified either algebraically or
 * by applying the edit and running the suite. Add an entry only with that
 * done, and put the REASON next to the code as an invariant, not here — a
 * list of survivors goes stale, and an invariant is what a reader needs
 * anyway.
 */
export const KNOWN_EQUIVALENT = {
  // `tags ?? []` only matters when the element carries no `tags` at all, and
  // then the substitute is iterated as a tag: a string with no colon is not
  // a scoped tag, `parseScopedTag` answers `undefined`, and the loop
  // continues to the same `undefined` the empty array gives. Any colon-free
  // substitute is equivalent; one with a colon would not be, and the mutator
  // never writes one. The empty-library half of the guard is a SHORTCUT:
  // with no key declared nothing colours, `changed` stays false and the same
  // canvas comes back either way, so dropping the check only walks the
  // elements for nothing — the identity example passes on both sides.
  'src/tags/declared-colours.ts': {
    'ArrayDeclaration: [] -> ["Stryker was here"]': 1,
    'ConditionalExpression: Object.keys(library).length === 0 -> false': 1,
  },
  // Three guards the ink cannot be made to notice. `String(-0)` is already
  // `'0'`, so the guard that spells a negative zero as `0` drops a
  // normalisation the string conversion performs on its own. An arc's
  // midpoints stop one short of its vertices, and the chord loop reads only
  // the first `n - 1`, so admitting the extra one pushes a midpoint nothing
  // reads. And `strokeCurve`'s empty-input return is dead: every outline
  // that reaches it carries 13 or 24 sampled vertices. Each hand-verified by
  // applying the edit and running the ink suites, which stay green.
  // Freedoms the nearest point does not depend on, written beside the code:
  // which end a segment is walked from, which of two equally near points a
  // tie keeps, and two guards the code after them already implies (no node
  // has an undefined id; an empty path answers the stored point). Each
  // hand-verified against `comment-geometry.property.test.ts`, which stays
  // green under every one and goes red under the module's other eleven.
  'src/comment-geometry.ts': {
    'ArithmeticOperator: i + 1 -> i - 1': 1,
    'EqualityOperator: distance < bestDistance -> distance <= bestDistance': 1,
    'ConditionalExpression: comment.targetNodeId !== undefined -> true': 1,
    'EqualityOperator: path.length > 0 -> path.length >= 0': 1,
    'ConditionalExpression: path.length > 0 -> true': 1,
  },
  'src/ink/sketch.ts': {
    'ConditionalExpression: rounded === 0 -> false': 1,
    'ConditionalExpression: n === 0 -> false': 1,
    'ConditionalExpression: i < ARC_SAMPLES -> true': 1,
    'EqualityOperator: i < ARC_SAMPLES -> i <= ARC_SAMPLES': 1,
    // The dead empty-curve return's own value.
    'StringLiteral: \'\' -> "Stryker was here!"': 1,
    // The clip's redundant checks, the hatch's last ruling, the dense arrow
    // list and an unmatched jump — each invariant is beside its code, each
    // hand-verified green under `ink/sketch-replay.test.ts`, whose hatch replay
    // and degenerate-input examples kill the clip's other mutants.
    'EqualityOperator: area >= 0 -> area > 0': 1,
    'ArithmeticOperator: -ey * inwardSign -> -ey / inwardSign': 1,
    'ArithmeticOperator: ex * inwardSign -> ex / inwardSign': 1,
    'ConditionalExpression: numerator < 0 -> false': 1,
    'EqualityOperator: denominator > 0 -> denominator >= 0': 1,
    'ConditionalExpression: tEnter > tExit -> false': 1,
    'EqualityOperator: tEnter > tExit -> tEnter >= tExit': 1,
    'EqualityOperator: tExit - tEnter < 1 -> tExit - tEnter <= 1': 1,
    'LogicalOperator: !Number.isFinite(tEnter) || !Number.isFinite(tExit) -> !Number.isFinite(tEnter) && !Number.isFinite(tExit)': 1,
    'EqualityOperator: offset <= reach -> offset < reach': 1,
    'ArrayDeclaration: [] -> ["Stryker was here"]': 1,
    'ConditionalExpression: tip === undefined -> false': 1,
    'ConditionalExpression: left === undefined -> false': 1,
    'ConditionalExpression: tip === undefined || left === undefined -> false': 1,
    'LogicalOperator: tip === undefined || left === undefined -> tip === undefined && left === undefined': 1,
  },
  // Belt-and-braces guards whose removal is masked by a guarantee the caller
  // already makes, plus type tests that a second test repeats. The load-bearing
  // ones are pinned by examples in `hoist.test.ts`; these are not, because
  // nothing can distinguish them. Hand-verified one at a time against the full
  // 1008-test suite. Two neighbours of these are NOT here and were pinned
  // instead — writing every hoistable name unconditionally erases a container's
  // own attribute, and the every-child comparison throws on an attr-less child.
  'src/svg/hoist.ts': {
    'ConditionalExpression: !isVNode(child) -> false': 1,
    'ConditionalExpression: attrs === undefined -> false': 1,
    'ConditionalExpression: children === undefined -> false': 1,
    'ConditionalExpression: elements.length === 0 -> false': 1,
    'ConditionalExpression: hoisted.size === 0 -> false': 1,
    'ConditionalExpression: names.size === 0 -> false': 1,
    'ConditionalExpression: node.attrs === undefined -> false': 1,
    'ConditionalExpression: node.attrs === undefined || names.size === 0 -> false': 1,
    'ConditionalExpression: node.defs === undefined -> false': 1,
    "ConditionalExpression: typeof child === 'string' -> false": 1,
    'LogicalOperator: node.attrs === undefined || names.size === 0 -> node.attrs === undefined && names.size === 0': 1,
    'MethodExpression: children.filter(isVNode) -> children': 1,
    'ObjectLiteral: { changed: false } -> {}': 1,
    'OptionalChaining: elements[0]?.attrs -> elements[0].attrs': 1,
    'StringLiteral: \'string\' -> ""': 1,
  },
  // `formatCoord`'s three belt-and-braces guards, each unobservable because of
  // a property of the other two — the reasoning is on the function itself.
  // Hand-verified: removing any one of them leaves all 1002 canvas-render
  // tests green.
  'src/svg/format.ts': {
    "ConditionalExpression: stripped === '' -> false": 1,
    'ConditionalExpression: value === 0 -> false': 1,
    'StringLiteral: \'\' -> "Stryker was here!"': 1,
    'StringLiteral: \'.\' -> ""': 1,
  },
}
