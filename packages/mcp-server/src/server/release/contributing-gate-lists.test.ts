// CONTRIBUTING's two lists — what pre-push runs, and what vitest projects
// exist — are DERIVED from their sources rather than compared against a
// second hand-written list.
//
// Both had drifted, in the direction that is invisible to a reader: the
// pre-push bullet named five commands where lefthook runs six, omitting the
// mutation-lane check — whose own comment in lefthook.yml says it "is the
// only check anywhere that notices the mutation lane going stale", a gate
// whose failure mode is silence and which the contributor doc did not
// mention exists. The project list named sixteen of twenty-two, omitting
// facet-engine, facet-ui, both plugin-visual projects, loro-adapter and
// search.
//
// A doc that undercounts a gate is worse than one that does not describe it,
// because a contributor reads the short list and believes the gate is
// smaller than it is. `local-gate-command.test.ts` closes the same class for
// `check:local`; this closes it for the two lists a new contributor reads
// first.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')

function contributing(): string {
  return readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf-8')
}

/**
 * The `run:` commands under lefthook.yml's `pre-push:` block.
 *
 * A line scan rather than a YAML parse: mcp-server has no YAML dependency,
 * and the shape being read is two levels of fixed indentation that lefthook's
 * own schema fixes. The plausible-count assertion below is what catches the
 * scan silently matching nothing.
 */
function prePushCommands(): string[] {
  const text = readFileSync(join(ROOT, 'lefthook.yml'), 'utf-8')
  const start = text.indexOf('\npre-push:')
  if (start === -1) throw new Error('lefthook.yml has no `pre-push:` block')
  const rest = text.slice(start + 1)
  const nextTopLevel = rest.slice('pre-push:'.length).search(/\n(?=[A-Za-z_-]+:)/)
  const block = nextTopLevel === -1 ? rest : rest.slice(0, 'pre-push:'.length + nextTopLevel)
  return [...block.matchAll(/^ {6}run: (.+)$/gm)].map((m) => m[1].trim())
}

interface VitestProjectsModule {
  readVitestProjects: (repoRoot: string) => Array<{ name: string | undefined }>
}

async function projectNames(): Promise<string[]> {
  const { readVitestProjects } = (await import(
    pathToFileURL(join(ROOT, 'tools/checks/src/vitest-projects.mjs')).href
  )) as VitestProjectsModule
  return readVitestProjects(ROOT)
    .map((project) => project.name)
    .filter((name): name is string => name !== undefined)
}

describe('CONTRIBUTING describes the gates that actually exist', () => {
  // Both scans are asserted to REACH their subject before anything is
  // concluded from them. A scan that stops matching reports every entry as
  // satisfied — the same shape as a passing run.
  it('the lefthook scan finds the pre-push commands', () => {
    expect(prePushCommands().length).toBeGreaterThanOrEqual(5)
  })

  it('the vitest derivation finds the projects', async () => {
    expect((await projectNames()).length).toBeGreaterThanOrEqual(20)
  })

  it('names every command pre-push runs', () => {
    const text = contributing()
    const missing = prePushCommands().filter((command) => !text.includes(command))
    expect(missing).toEqual([])
  })

  it('names every vitest project', async () => {
    const text = contributing()
    const missing = (await projectNames()).filter((name) => !text.includes(name))
    expect(missing).toEqual([])
  })

  // The prose also states both sizes in words, and a count is exactly what
  // the checks above cannot reach: adding a project fails them until the
  // table names it, but nothing would stop the sentence above the table from
  // still saying the old number. Complementary to the name checks, never a
  // substitute — `release-gate-matrix.test.ts` pinned a chain at the right
  // length while a third of it did not run.
  const WORDED = new Map([
    ['five', 5],
    ['six', 6],
  ])

  it('states the number of pre-push checks correctly', () => {
    const stated = /runs (\w+) checks in parallel/.exec(contributing())
    expect(stated).not.toBeNull()
    const claimed = WORDED.get(stated?.[1] ?? '') ?? Number(stated?.[1])
    expect(claimed).toBe(prePushCommands().length)
  })

  it('states the number of vitest projects correctly', async () => {
    const count = (await projectNames()).length
    const stated = [...contributing().matchAll(/(\d+) vitest projects/g)].map((m) => Number(m[1]))
    expect(stated.length).toBeGreaterThanOrEqual(2)
    expect(stated).toEqual(stated.map(() => count))
  })
})
