import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOOP_COSTS, stallCeilingMs } from './background-work-costs.js'

const SERVER_SRC = fileURLToPath(new URL('.', import.meta.url))

/** Where workers are declared and armed. Same pair `background-work.guard.test.ts` walks. */
const COMPOSITION_ROOTS = ['http-server.ts', 'server-mode-http.ts'] as const

/**
 * Workers whose ceiling no test asserts, and why that is right rather than
 * missing.
 *
 * A list rather than a sentinel field, and guarded from both sides below: an
 * entry that suppresses nothing fails, so it cannot outlive its reason. Same
 * shape as arch-lint's `ADAPTER_SCAN_EXEMPT_FILES`, for the same purpose —
 * an exemption is a CLASSIFICATION, and one nobody can see decays into a way
 * of not answering.
 */
const NO_MEASUREMENT_POSSIBLE: Record<string, string> = {
  'idle-shutdown':
    'compares two timestamps and calls nothing; there is no work to run a sampler around, ' +
    'and a test asserting 0 <= 0 would be a guard that cannot fail',
}

async function testSources(): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.test.ts')) found.push(await readFile(path, 'utf8'))
    }
  }
  await walk(SERVER_SRC)
  return found
}

/** Every worker name some test passes to `stallCeilingMs`. */
async function namesAsserted(): Promise<Set<string>> {
  const asserted = new Set<string>()
  for (const source of await testSources()) {
    for (const match of source.matchAll(/stallCeilingMs\(\s*'([^']+)'\s*\)/g)) {
      const name = match[1]
      if (name !== undefined) asserted.add(name)
    }
  }
  return asserted
}

/**
 * A declared ceiling that nothing asserts is the defect one level up.
 *
 * `background-work.ts`'s `stallCeilingMs` is a contract only while a test
 * reads it. Before that it was prose, and prose is exactly how the workspace
 * tail came to declare 283ms beside a citation of a test that measures
 * 20-29ms — the number from a scratch script at a bigger fixture, the
 * citation written from memory, and nothing anywhere to notice.
 *
 * Wiring each of today's two tests to its declaration fixes today's two. This
 * is what stops the third from arriving unchecked.
 */
describe('every declared stall ceiling is asserted by a test', () => {
  it('covers each in-process worker, or says why it cannot be measured', async () => {
    const asserted = await namesAsserted()
    // The scan reached something: a regex that quietly stopped matching would
    // otherwise report every worker as unasserted and send the reader to the
    // wrong file entirely.
    expect(asserted.size).toBeGreaterThan(0)

    const unchecked = Object.entries(LOOP_COSTS)
      .filter(([name, cost]) => cost.runs === 'in-process' && !asserted.has(name))
      .map(([name]) => name)
      .filter((name) => NO_MEASUREMENT_POSSIBLE[name] === undefined)

    expect(unchecked).toEqual([])
  })

  /**
   * Both directions, or the exemption list becomes a place to put a worker
   * somebody did not want to measure.
   */
  it('has no exemption that suppresses nothing', async () => {
    const asserted = await namesAsserted()
    for (const name of Object.keys(NO_MEASUREMENT_POSSIBLE)) {
      const cost = LOOP_COSTS[name as keyof typeof LOOP_COSTS]
      expect(cost, `${name} is exempted but is not a declared worker`).toBeDefined()
      expect(cost?.runs, `${name} is exempted but does not run in-process`).toBe('in-process')
      expect(asserted.has(name), `${name} is exempted but a test asserts it anyway`).toBe(false)
    }
  })

  /**
   * The bypass, and it is the one that matters: `BackgroundWork.loop` takes a
   * `LoopCost`, so a new worker can declare `{ runs: 'in-process',
   * stallCeilingMs: 0, ... }` INLINE in a composition root and never appear
   * in `LOOP_COSTS` at all. That typechecks, passes the arming guard, and
   * passes the coverage test above — reinstating the unbacked number this
   * whole file exists to prevent, one level to the side.
   *
   * So every declaration has to come through the map, and has to come through
   * its OWN entry: a worker named `x` reaching for `LOOP_COSTS['y']` would
   * publish the wrong worker's ceiling and be asserted by the wrong test.
   */
  it('leaves no worker declaring its cost inline, or under another name', async () => {
    for (const root of COMPOSITION_ROOTS) {
      const source = await readFile(join(SERVER_SRC, root), 'utf8')
      // Comments first: these files discuss `loop:` and the registry in prose.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

      const declarations = [...code.matchAll(/name: '([^']+)',[\s\S]*?loop: ([^,\n]+)/g)]
      // The scan reached something: a pattern that stopped matching would
      // otherwise report every root as clean.
      expect(declarations.length, `${root} declares no workers`).toBeGreaterThan(0)

      for (const declaration of declarations) {
        const [, name, loop] = declaration
        expect(
          loop,
          `${root}: ${name} must read LOOP_COSTS['${name}'] — an inline literal is a number ` +
            "nothing asserts, and another worker's entry publishes the wrong ceiling and is " +
            'checked by the wrong test',
        ).toBe(`LOOP_COSTS['${name}']`)
      }
    }
  })

  it('refuses to hand a ceiling for a worker that runs in a subprocess', () => {
    // Reading `undefined` into a `<=` comparison is false either way, so a
    // test that reached for a subprocess worker's ceiling would pass while
    // asserting nothing.
    expect(() => stallCeilingMs('backup-scheduler')).toThrow(/subprocess/)
  })
})
