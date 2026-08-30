// The modules the mutation lane covers, in a plain module of their own so
// three consumers can read the same list without loading Stryker: the config,
// the PR scoping script, and the guard test that keeps this honest.
//
// It is a LIST rather than "the whole package", and that is a budget decision
// backed by a measurement: instrumenting every production source file yields
// 9089 mutants against these nine's 2225, and at the ~3s per mutant this
// package measures, even the LIST is a run of nearly two hours and the whole
// package would be most of a working day. What a list costs is that it goes
// stale silently — a module added next month is simply not covered and
// nothing says so — which is why `mutation-lane-coverage.test.ts` pins both
// this list and the package's production file count EXACTLY. Adding a module
// then fails that test until someone decides, in the diff, whether the lane
// should cover it.
//
// The diff-scoped PR run reads this list too, so a file's absence here means
// no PR feedback on it either. Weigh that when adding a module: a file with
// properties worth trusting belongs in the lane; one whose tests are examples
// only will report true-but-unsurprising survivors.
export const MUTATED = [
  // The cost model and the searches the differential oracles cover.
  'src/layout/edges/edge-rules.ts',
  'src/layout/edges/edge-crossing-sweep.ts',
  'src/layout/edges/grid-route.ts',
  // Serialization: escaping and character legality, byte-identical output.
  'src/svg/format.ts',
  'src/svg/hoist.ts',
  // Pure geometry and derivation with properties of their own.
  'src/scene-bounds.ts',
  'src/scene-digest.ts',
  'src/layout/nodes/truncate.ts',
  'src/tidy.ts',
  // NOT `src/layout/seed.ts`, and the reason is a measurement rather than a
  // judgement about its value. Stryker selects the test files related to a
  // mutated module, and seed.ts is imported by its own test and nothing else:
  // 7 tests, against the 458 that cover `svg/format.ts`. In that narrow
  // selection its runtime mutants come back SURVIVED even when the same edit
  // applied by hand fails the suite — verified on `/ 4294967296` ->
  // `* 4294967296`, which Stryker called a survivor while `every draw is
  // finite and in [0, 1)` goes red on it in a plain `vitest run`. A file whose
  // report is known wrong does not belong in a lane whose whole output is a
  // list of survivors to trust.
]

/**
 * Survivors that NO test can kill, because the mutation does not change what
 * the code does. They are a real triage answer rather than debt, and without
 * somewhere to record them the same set is re-investigated every time the
 * lane runs — `edge-crossing-sweep.ts` alone reports 23 of them on every
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
 * Nothing here is taken on trust: each was verified either algebraically or
 * by applying the edit and running the suite. Add an entry only with that
 * done, and put the REASON next to the code as an invariant, not here — a
 * list of survivors goes stale, and an invariant is what a reader needs
 * anyway.
 */
export const KNOWN_EQUIVALENT = {
  // Every one of these is the broad phase, whose comparisons cannot change
  // the answer in either direction, or a narrow-phase boundary whose two
  // sides compute the same value. The invariant is on `buildPairwiseScores`;
  // the algebra for `hi > lo`, `denom < 0` and `axisLength` is in the clause
  // each sits in. Hand-verified: deleting the y-gate, dropping the parallel
  // early return, and seeding either array with junk each leave all 983
  // canvas-render tests green.
  'src/layout/edges/edge-crossing-sweep.ts': {
    'ArithmeticOperator: 1 / COST_QUANTUM -> 1 * COST_QUANTUM': 1,
    'ArithmeticOperator: s1.edge - s2.edge -> s1.edge + s2.edge': 1,
    'ArithmeticOperator: s1.maxX - s2.maxX -> s1.maxX + s2.maxX': 1,
    'ArrayDeclaration: [] -> ["Stryker was here"]': 2,
    'ConditionalExpression: active[i]!.maxX >= segment.minX -> true': 1,
    'ConditionalExpression: denom === 0 -> false': 1,
    'ConditionalExpression: dx === 0 -> false': 1,
    'ConditionalExpression: dy === 0 -> false': 1,
    'ConditionalExpression: illegible === 0 -> true': 1,
    'ConditionalExpression: other.maxY < segment.minY -> false': 1,
    'ConditionalExpression: other.maxY < segment.minY || other.minY > segment.maxY -> false': 1,
    'ConditionalExpression: other.minY > segment.maxY -> false': 1,
    'ConditionalExpression: overlap === 0 && illegible === 0 && crossings === 0 -> false': 1,
    'EqualityOperator: active[i]!.maxX >= segment.minX -> active[i]!.maxX > segment.minX': 1,
    'EqualityOperator: denom < 0 -> denom <= 0': 1,
    'EqualityOperator: hi > lo -> hi >= lo': 2,
    'EqualityOperator: illegible === 0 -> illegible !== 0': 1,
    'EqualityOperator: other.edge < segment.edge -> other.edge <= segment.edge': 1,
    'EqualityOperator: other.maxY < segment.minY -> other.maxY <= segment.minY': 1,
    'EqualityOperator: other.minY > segment.maxY -> other.minY >= segment.maxY': 1,
    'LogicalOperator: other.maxY < segment.minY || other.minY > segment.maxY -> other.maxY < segment.minY && other.minY > segment.maxY': 1,
  },
}
