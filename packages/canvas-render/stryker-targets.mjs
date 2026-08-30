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
