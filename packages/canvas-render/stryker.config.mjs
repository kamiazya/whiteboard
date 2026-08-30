import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * Mutation testing for the modules this package's PROPERTIES are supposed to
 * pin. It is the systematic form of the by-hand mutation check the repo's
 * disciplines already ask for, and it exists because two properties here were
 * found asserting nothing at all — a cache-hit branch that no run reached and
 * a predicate whose false case one draw in a billion could produce. Both would
 * have shown up as surviving mutants.
 *
 * A survivor is a REPORT, never a gate: it says some line can be changed
 * without a test noticing. Triage it the way a review finding is triaged —
 * usually a generator that does not reach the case (fix the domain and add a
 * reachability guard), sometimes a rule nothing states, sometimes a line whose
 * behaviour genuinely does not matter.
 *
 * VERIFY A SURVIVOR BY HAND BEFORE ACTING ON IT. This tool can report one
 * falsely — see the `seed.ts` note on `mutate` below — so a survivor is a
 * hypothesis, and the check is the one the repo already asks for: apply that
 * exact edit, run the suite, watch it stay green. A survivor that turns red
 * by hand is the tool's finding, not the code's.
 *
 * `mutate` is a deliberate list rather than the whole package. Stryker's cost
 * is mutants x the tests covering each one, and the value is concentrated in
 * the pure, property-covered modules below. Add a file when it gains a
 * property worth trusting.
 *
 * @type {import('@stryker-mutator/core').PartialStrykerOptions}
 */
export default {
  // Resolved from THIS file rather than named: Stryker loads a plugin from
  // its own location in the store, where a pnpm workspace's dependency is not
  // resolvable, and a bare directory path is not a legal ESM import either.
  // `require.resolve` from the config gives the entry FILE, from the package
  // that actually declares the dependency.
  plugins: [require.resolve('@stryker-mutator/vitest-runner')],
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.stryker.config.ts',
  },
  mutate: [
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
    // mutated module, and seed.ts is imported by its own test and nothing
    // else: 7 tests, against the 458 that cover `svg/format.ts`. In that
    // narrow selection its runtime mutants come back SURVIVED even when the
    // same edit applied by hand fails the suite — verified on
    // `/ 4294967296` -> `* 4294967296`, which Stryker called a survivor while
    // `every draw is finite and in [0, 1)` goes red on it in a plain
    // `vitest run`. A file whose report is known wrong does not belong in a
    // lane whose whole output is a list of survivors to trust.
  ],
  reporters: ['progress', 'clear-text', 'html', 'json'],
  htmlReporter: {
    fileName: 'tmp/stryker-reports/mutation.html',
  },
  // The machine-readable half, for the PR comment: a weekly HTML artifact is
  // a number nobody opens, and the lane is worth nothing unless somebody sees
  // its survivors.
  jsonReporter: {
    fileName: 'tmp/stryker-reports/mutation.json',
  },
  coverageAnalysis: 'off',
  // A property runs 200 cases, so the default 5s budget times out on slow but
  // perfectly healthy mutants — and a timeout counts as KILLED, which flatters
  // the score instead of reporting a gap. Raised so a timeout means what it
  // should: the mutant made the code loop.
  timeoutMS: 20_000,
  tempDirName: 'tmp/stryker-sandbox',
  // Stryker rewrites a tsconfig's project references when it copies the
  // project into its sandbox, and that step imports `typescript` from
  // Stryker's own directory — unresolvable in a pnpm workspace. Nothing here
  // needs the rewrite: vitest transforms the sources itself and this package
  // declares no project references. Pointing at a file that does not exist is
  // how the step is skipped.
  tsconfigFile: 'tsconfig.stryker-skip.json',
  // Report-only: the lane never fails on a score, so a survivor lands as a
  // finding to triage rather than as a red build nobody can act on at 2am.
  thresholds: { high: 100, low: 0, break: null },
}
