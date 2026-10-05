import { afterAll, type RunnerTask } from 'vitest'

/**
 * Which tests feed a floor: the titles (exact, or a pattern for a
 * `test.each` / loop-built family) of the tests whose run fills its counters,
 * or `'every test'` in the suite the floor is declared in.
 */
export type FloorFeeders = 'every test' | readonly (string | RegExp)[]

/** The part of a vitest task this helper reads, so it can be judged without a runner. */
type FloorTask = Pick<RunnerTask, 'type' | 'name'> & {
  readonly result?: { readonly state: NonNullable<RunnerTask['result']>['state'] }
  readonly tasks?: readonly FloorTask[]
}

export type FloorSuite = { readonly tasks: readonly FloorTask[] }

function testsIn(tasks: readonly FloorTask[]): FloorTask[] {
  return tasks.flatMap((task) => (task.type === 'test' ? [task] : testsIn(task.tasks ?? [])))
}

/**
 * `fcTest.prop` registers its test as `<title> (with seed=<n>)`, a new seed
 * every run, so a feeder named by its written title matches that too.
 */
const titled = (task: FloorTask, title: string) =>
  task.name === title || task.name.startsWith(`${title} (with seed=`)

const ran = (task: FloorTask) => task.result?.state === 'pass' || task.result?.state === 'fail'

/**
 * Whether every test feeding a floor actually ran.
 *
 * Asked of the FEEDERS rather than of the whole suite, because vitest marks a
 * test a name filter excluded and a test written `it.skip` identically
 * (`mode: 'skip'`): "no test in the suite was skipped" would let any
 * quarantined neighbour silence the floor for good, while a test that feeds
 * nothing cannot make the floor's counters any less meaningful.
 *
 * A feeder title that matches no test throws: a rename would otherwise turn
 * the floor off forever while every run stayed green.
 */
export function floorIsFed(suite: FloorSuite, feeders: FloorFeeders): boolean {
  const tests = testsIn(suite.tasks)
  if (feeders === 'every test') {
    if (tests.length === 0) throw new Error('a reachability floor sits in a suite with no test')
    return tests.every(ran)
  }
  return feeders.every((feeder) => {
    const matches = tests.filter((test) =>
      typeof feeder === 'string' ? titled(test, feeder) : feeder.test(test.name),
    )
    if (matches.length === 0) {
      throw new Error(
        `a reachability floor names a feeder this suite does not hold: ${String(feeder)}`,
      )
    }
    return matches.every(ran)
  })
}

/**
 * A reachability floor or a ledger tally, asserted once its suite is done —
 * and only when the tests feeding it ran.
 *
 * A floor asserts what a whole run drew, so a run that filtered its feeders
 * away (`-t`, an editor's run-this-test, a line filter, `.only`) has drawn
 * nothing, and failing it there names no filter: it reads as a property that
 * proved nothing. A full run still fails an unmet floor exactly as before.
 *
 * The hook's first parameter is destructured because vitest parses it for
 * fixtures and refuses any other shape in a file that registers fixtures.
 */
export function afterAllFloor(feeders: FloorFeeders, floor: () => void | Promise<void>): void {
  // biome-ignore lint/correctness/noEmptyPattern: vitest reads the hook's first parameter as a fixture pattern, so it must be a destructuring one
  afterAll(async ({}, suite) => {
    if (floorIsFed(suite, feeders)) await floor()
  })
}
