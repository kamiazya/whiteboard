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
import { codeText } from '../../shared/test-utils/markdown-code.js'
import { bareScriptNames, declaresScript, scriptsOf } from '../../shared/test-utils/pnpm-scripts.js'
import { jobSection } from './job-section.js'

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
    ['seven', 7],
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

// The release section is the other part of CONTRIBUTING that described a
// workflow which no longer existed: it said the release run does `pnpm test`
// then `build` and `npm publish`, after `publish-mcp` had moved to the
// matrix-driven `pnpm publish-gate` precisely so it would NOT re-run the suite
// verify CI already ran at that SHA. Each document below is held to the
// workflow itself and to the root scripts it names.
describe('the release documentation describes the workflow that ships', () => {
  const releaseSection = (): string => {
    const text = contributing()
    const start = text.indexOf('## Release / Publish')
    const end = text.indexOf('\n## ', start + 1)
    return start === -1 ? '' : text.slice(start, end === -1 ? undefined : end)
  }

  const RELEASE_DOCS = [
    'docs/contributing/releasing.md',
    'packages/mcp-server/src/server/release/release-signing-provenance-sbom.md',
  ]
  const rootScripts = scriptsOf(ROOT)

  it("CONTRIBUTING's release section names the publish gate and not a re-run of the suite", () => {
    const section = releaseSection()
    expect(section).toContain('pnpm publish-gate')
    expect(
      section,
      'publish-mcp runs the publish tier, so no step bullet is `pnpm test`',
    ).not.toMatch(/^\s+- `pnpm (test|typecheck|smoke:e2e)`/m)
  })

  it('CONTRIBUTING points the local pre-release check at a script that exists', () => {
    expect(releaseSection()).toContain('pnpm check:release-candidate')
  })

  it('every bare `pnpm <script>` a release document types is a root script', () => {
    const documents = [
      ['CONTRIBUTING.md', releaseSection()],
      ...RELEASE_DOCS.map((path) => [path, readFileSync(join(ROOT, path), 'utf-8')] as const),
    ] as const
    // Reached, not assumed: an empty extraction passes every name check.
    expect(
      documents.reduce((n, [, text]) => n + bareScriptNames(codeText(text)).length, 0),
    ).toBeGreaterThan(15)
    const dangling = documents.flatMap(([path, text]) =>
      bareScriptNames(codeText(text))
        .filter((name) => !declaresScript(rootScripts, name))
        .map((name) => `${path}: pnpm ${name}`),
    )
    expect(dangling).toEqual([])
  })

  it('the SBOM document lists the root scripts each publish job runs, and no aggregate they skip', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf-8')
    const doc = readFileSync(join(ROOT, RELEASE_DOCS[1] ?? ''), 'utf-8')
    const start = doc.indexOf('## What the production publish workflow v0 implements')
    const section = doc.slice(start, doc.indexOf('\n## ', start + 1))
    expect(start).toBeGreaterThan(-1)
    const jobs = [
      jobSection(workflow, 'publish-mcp', 'docker-publish-sign'),
      jobSection(workflow, 'docker-publish-sign'),
    ]
    const run = jobs.flatMap(bareScriptNames)
    const gates = run.filter(
      (name) => name in rootScripts && /^(publish-gate|smoke:docker)/.test(name),
    )
    expect(gates.length).toBeGreaterThanOrEqual(3)
    for (const name of gates) expect(section, `${name} runs in a publish job`).toContain(name)
    expect(section, 'neither publish job runs the release-candidate aggregate').not.toContain(
      'check:release-candidate',
    )
  })
})

// AGENTS.md's completion checklist says full suites are CI's job and a local
// full run is the same work twice. The two documents a contributor meets
// first said the opposite — "`pnpm test` is green", "passes locally" — so the
// same repo asked for a gate its own rules call redundant. `pnpm test` stays
// the optional everything command; it just is not a requirement.
describe('no contributor-facing checklist requires a local full-suite run', () => {
  const CHECKBOX_NAMING_FULL_SUITE = /^\s*(?:- \[[ x]\]|-) .*`pnpm test`/m

  it("AGENTS.md still says full suites are CI's job, which is the premise", () => {
    expect(readFileSync(join(ROOT, 'AGENTS.md'), 'utf-8')).toContain('Full suites are CI')
  })

  it("CONTRIBUTING's pull request checklist does not require `pnpm test`", () => {
    const text = contributing()
    const start = text.indexOf('## Pull request checklist')
    expect(start).toBeGreaterThan(-1)
    const section = text.slice(start, text.indexOf('\n## ', start + 1))
    expect(section).toContain('pnpm check:local')
    expect(section).not.toMatch(CHECKBOX_NAMING_FULL_SUITE)
  })

  it('the pull request template does not require `pnpm test`', () => {
    const template = readFileSync(join(ROOT, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf-8')
    expect(template).toContain('- [ ]')
    expect(template).not.toMatch(CHECKBOX_NAMING_FULL_SUITE)
  })
})
