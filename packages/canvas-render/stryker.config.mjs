import { createRequire } from 'node:module'
import { MUTATED, shardOf } from './stryker-targets.mjs'

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
  // `MUTATION_SHARD=k/n` narrows a run to one leg's share of the list, which
  // is how the weekly job fits inside a runner's time limit; a `--mutate` flag
  // still overrides it, as the per-PR job relies on.
  mutate: shardOf(MUTATED, process.env.MUTATION_SHARD),
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
  // `perTest` skips a mutant no test reaches and gives every other mutant only
  // the tests that cover its line. Measured against `off` on two files (108
  // mutants): the same suite and a 25% smaller CPU bill (21 CPU-minutes against
  // 28), 1300 tests run against 1438, and no mutant that `off` killed
  // survived. It depends on the patched vitest runner's per-test ids (see
  // `patches/@stryker-mutator__vitest-runner@9.6.1.patch`), which join suite
  // and test names the way vitest 5 matches them.
  coverageAnalysis: 'perTest',
  // A property runs 200 cases, so the default 5s budget times out on slow but
  // perfectly healthy mutants — and a timeout counts as KILLED, which flatters
  // the score instead of reporting a gap. Raised so a timeout means what it
  // should: the mutant made the code loop.
  timeoutMS: 20_000,
  // Stryker's default is 5 minutes, and the initial run executes the whole
  // project serially with coverage on, so a loaded box or a slow runner reads
  // as a config error rather than as slow.
  // measured: 2026-10-03 4 min on 4 cores at load 14-16 (4.2 CPU-minutes)
  dryRunTimeoutMinutes: 15,
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
