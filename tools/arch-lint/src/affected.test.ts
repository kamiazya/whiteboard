// A pull request skips the tests and jobs its change cannot reach
// (tools/checks/src/affected.mjs). Every skip rests on the selection being a
// SUPERSET of what the change needs, so this file holds that from both sides:
// synthetic graphs pin each rule, and the real tree pins that every package,
// project and ci.yml job is reachable by some rule — a new package that no
// rule selects would otherwise never be tested on a pull request, silently.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { REPO_ROOT } from './scan-roots.js'
import { extractWorkflowJobs } from './workflow-jobs.js'

interface GraphNode {
  id: string
  dir: string
  deps: string[]
  source: string
}
interface Project {
  name: string
  configPath: string
  isBrowser: boolean
  node: string
  job: string
}
interface JobPlan {
  run: boolean
  projects: string[] | null
  reason: string
}
interface Plan {
  everything: boolean
  reasons: string[]
  touched: string[]
  affected: string[]
  projects: string[]
  jobs: Record<string, JobPlan>
}
type Readers = Record<string, { testReaders: string[]; sourceReaders: string[] }>

// lazy-import: loaded by path, since a relative import of tools/checks leaves
// this workspace and `relative-import-escape` refuses it.
const affected = (await import(
  pathToFileURL(join(REPO_ROOT, 'tools/checks/src/affected.mjs')).href
)) as {
  planScope: (input: {
    changes: { path: string; status: string }[]
    event: string
    nodes: GraphNode[]
    projects: Project[]
    readers: Readers
  }) => Plan
  readRepoInputs: (repoRoot: string) => {
    nodes: GraphNode[]
    projects: Project[]
    readers: Readers
  }
  dependentsClosure: (roots: string[], nodes: GraphNode[]) => string[]
  owningNode: (path: string, nodes: GraphNode[]) => GraphNode | undefined
  scanTreeReaders: (input: {
    files: string[]
    nodes: GraphNode[]
    read: (path: string) => string | null
    trees?: string[]
  }) => Readers
  namesTree: (text: string, tree: string) => boolean
  parseWorkspaceGlobs: (yamlText: string) => string[]
  parseNameStatus: (text: string) => { path: string; status: string }[]
  validateSelection: (selected: unknown, universe: string[]) => string[]
  jobUniverse: (jobId: string, projects: Project[]) => string[]
  SELECTS_EVERYTHING: { pattern: RegExp; why: string }[]
  READ_TREES: string[]
  READ_ROOT_FILES: string[]
  REPO_WIDE_READERS: Record<string, string>
  CROSS_PACKAGE_READS: { reader: string; target: string; why: string }[]
  TEST_INVENTORY_READERS: Record<string, string>
  PROJECT_JOBS: string[]
  PACKAGE_JOBS: Record<string, { packages: string[]; why: string }>
  PATH_JOBS: Record<string, { scope: { files: string[]; trees: string[] }; why: string }>
  UNSCOPED_JOBS: Record<string, string>
}

// lazy-import: loaded by path, since a relative import of tools/checks leaves
// this workspace and `relative-import-escape` refuses it.
const vitestProjects = (await import(
  pathToFileURL(join(REPO_ROOT, 'tools/checks/src/vitest-projects.mjs')).href
)) as {
  deriveSharedLayerProjectNames: (root: string) => string[]
  readBrowserProjectNames: (root: string) => string[]
}
// lazy-import: loaded by path, since a relative import of tools/checks leaves
// this workspace and `relative-import-escape` refuses it.
const gate = (await import(
  pathToFileURL(join(REPO_ROOT, 'tools/checks/src/ci-gate.mjs')).href
)) as {
  NOT_AFFECTED_STEP: string
}

// lazy-import: loaded by path, since a relative import of the root config
// leaves this workspace and `relative-import-escape` refuses it.
const rootConfig = (
  (await import(pathToFileURL(join(REPO_ROOT, 'vitest.config.ts')).href)) as {
    default: { test?: { globalSetup?: string | string[] } }
  }
).default

// ── A synthetic graph: model <- codec <- web, and a dev-only edge ─────────

const node = (id: string, dir: string, deps: string[] = []): GraphNode => ({
  id,
  dir,
  deps,
  source: 'pnpm',
})
const project = (name: string, nodeId: string, job: string): Project => ({
  name,
  configPath: `${nodeId}/vitest.config.ts`,
  isBrowser: job === 'test-browser',
  node: nodeId,
  job,
})

const NODES: GraphNode[] = [
  node('model', 'packages/model'),
  node('codec', 'packages/codec', ['model']),
  node('web', 'apps/web', ['codec']),
  // Depends on model through a devDependency only: still a dependent.
  node('tooling', 'packages/tooling', ['model']),
  node('lonely', 'packages/lonely'),
  node('@kamiazya/whiteboard-arch-lint', 'tools/arch-lint'),
  node('@kamiazya/whiteboard-mcp', 'packages/mcp-server', ['codec']),
  node('@kamiazya/whiteboard-web', 'apps/web-real'),
]
const PROJECTS: Project[] = [
  project('model-node', 'model', 'test-shared'),
  project('codec-node', 'codec', 'test-shared'),
  project('web-jsdom', 'web', 'test-jsdom'),
  project('web-browser', 'web', 'test-browser'),
  project('tooling-node', 'tooling', 'test-shared'),
  project('lonely-node', 'lonely', 'test-shared'),
  project('arch-lint-node', '@kamiazya/whiteboard-arch-lint', 'test-shared'),
  project('mcp-node', '@kamiazya/whiteboard-mcp', 'test-unit'),
  project('real-web-jsdom', '@kamiazya/whiteboard-web', 'test-jsdom'),
]
const READERS: Readers = {
  docs: { testReaders: ['lonely'], sourceReaders: ['codec'] },
  '.claude': { testReaders: [], sourceReaders: [] },
  skills: { testReaders: [], sourceReaders: [] },
}

const plan = (paths: string[], event = 'pull_request', status = 'M') =>
  affected.planScope({
    changes: paths.map((path) => ({ path, status })),
    event,
    nodes: NODES,
    projects: PROJECTS,
    readers: READERS,
  })

describe('the selection on a synthetic graph', () => {
  it('selects a dependent of the changed package, and not a package beside it', () => {
    const result = plan(['packages/model/src/index.ts'])
    expect(result.everything).toBe(false)
    expect(result.projects).toEqual(
      expect.arrayContaining(['model-node', 'codec-node', 'web-jsdom', 'web-browser', 'mcp-node']),
    )
    expect(result.projects).not.toContain('lonely-node')
  })

  it('counts a devDependency edge as a dependent', () => {
    expect(plan(['packages/model/src/index.ts']).projects).toContain('tooling-node')
  })

  it('does not select a package the changed one depends on', () => {
    const result = plan(['apps/web/src/App.tsx'])
    expect(result.projects).toEqual(expect.arrayContaining(['web-jsdom', 'web-browser']))
    expect(result.projects).not.toContain('codec-node')
    expect(result.projects).not.toContain('model-node')
    expect(result.jobs['test-unit']?.run).toBe(false)
  })

  it('always runs the repo-wide readers', () => {
    expect(plan(['apps/web/src/App.tsx']).projects).toContain('arch-lint-node')
  })

  it.each([
    'pnpm-lock.yaml',
    'vitest.config.ts',
    'vitest.projects.json',
    'biome.json',
    '.node-version',
    'package.json',
    '.github/workflows/ci.yml',
    '.github/actions/setup-pnpm/action.yml',
    'tools/checks/src/affected.mjs',
    'tools/biome-plugins/test-flake-shapes.grit',
    'patches/some-dep.patch',
    '.claude/scripts/node-version-banner.mjs',
    'somewhere-new/file.ts',
  ])('selects everything for %s', (path) => {
    const result = plan(['apps/web/src/App.tsx', path])
    expect(result.everything).toBe(true)
    expect(result.projects).toEqual(PROJECTS.map((p) => p.name).sort())
    expect(Object.values(result.jobs).every((job) => job.run)).toBe(true)
    expect(result.reasons.join('\n')).toContain(path)
  })

  it.each([
    'push',
    'merge_group',
    'workflow_dispatch',
    'schedule',
    'unspecified',
  ])('selects everything on a %s event, whatever changed', (event) => {
    expect(plan(['apps/web/src/App.tsx'], event).everything).toBe(true)
  })

  it("runs a docs test-reader's own projects, and a docs source-reader's dependents", () => {
    const result = plan(['docs/reference/x.md'])
    expect(result.everything).toBe(false)
    expect(result.projects).toContain('lonely-node')
    // codec's shipped source names docs/: it and everything above it.
    expect(result.projects).toEqual(expect.arrayContaining(['codec-node', 'web-jsdom', 'mcp-node']))
    expect(result.projects).not.toContain('model-node')
  })

  it('runs the test-inventory readers when a test file is added or deleted, not when edited', () => {
    expect(plan(['packages/lonely/src/a.test.ts'], 'pull_request', 'A').projects).toContain(
      'real-web-jsdom',
    )
    expect(plan(['packages/lonely/src/a.test.ts'], 'pull_request', 'D').projects).toContain(
      'real-web-jsdom',
    )
    expect(plan(['packages/lonely/src/a.test.ts'], 'pull_request', 'M').projects).not.toContain(
      'real-web-jsdom',
    )
  })

  it("runs a cross-package reader's own projects when its target changes", () => {
    const result = plan(['tools/arch-lint/src/job-section.ts'])
    expect(result.projects).toContain('mcp-node')
    // Own projects only: mcp-server's dependents are not implied.
    expect(result.affected).not.toContain('@kamiazya/whiteboard-mcp')
  })

  it('skips a project job with nothing selected and says why', () => {
    const job = plan(['packages/lonely/src/x.ts']).jobs['test-jsdom']
    expect(job?.run).toBe(false)
    expect(job?.projects).toEqual([])
    expect(job?.reason).toMatch(/none of .* is affected/)
  })
})

describe('the Cargo workspace is scoped by path, not by the pnpm graph', () => {
  const RUST_PATHS = [
    'Cargo.toml',
    'Cargo.lock',
    'rust-toolchain.toml',
    'rustfmt.toml',
    'deny.toml',
    '.cargo/config.toml',
    'crates/core/det/src/lib.rs',
    'crates/fuzz/Cargo.lock',
    'crates/fuzz/fuzz_targets/det_utf16_len.rs',
    'crates/wasm-size-ledger.json',
    'crates/about.hbs',
  ]

  it.each(RUST_PATHS)('runs the Rust jobs and none of the vitest matrix for %s', (path) => {
    const result = plan([path])
    expect(result.everything, result.reasons.join('\n')).toBe(false)
    expect(result.jobs.rust?.run).toBe(true)
    expect(result.jobs['rust-fuzz-pr']?.run).toBe(true)
    expect(result.jobs.rust?.reason).toContain(path)
    for (const id of ['test-unit', 'test-jsdom', 'test-browser']) {
      expect(result.jobs[id]?.run, id).toBe(false)
    }
  })

  it('skips the Rust jobs for a change that reaches no Rust path, and says why', () => {
    const result = plan(['apps/web/src/App.tsx', 'docs/reference/x.md'])
    for (const id of ['rust', 'rust-fuzz-pr']) {
      expect(result.jobs[id]?.run, id).toBe(false)
      expect(result.jobs[id]?.projects).toBeNull()
      expect(result.jobs[id]?.reason).toMatch(/none of .*crates.* changed/)
    }
  })

  it('does not read a crate-shaped name outside the Rust trees as Rust', () => {
    // `crates-two/` is no Rust tree: unattributed, so it fails closed.
    expect(plan(['crates-two/x.rs']).everything).toBe(true)
    expect(plan(['packages/model/Cargo.toml']).jobs.rust?.run).toBe(false)
  })

  it('runs the Rust jobs when a Rust script changes, as part of everything', () => {
    const result = plan(['tools/checks/src/rust-check.mjs'])
    expect(result.everything).toBe(true)
    expect(result.jobs.rust?.run).toBe(true)
    expect(result.jobs['rust-fuzz-pr']?.run).toBe(true)
  })
})

describe('a path belongs to the innermost node around it', () => {
  it('attributes a nested node by its own directory, whichever order the nodes come in', () => {
    const outer = node('outer', 'crates/outer')
    const inner = node('inner', 'crates/outer/inner')
    for (const nodes of [
      [outer, inner],
      [inner, outer],
    ]) {
      expect(affected.owningNode('crates/outer/inner/src/lib.rs', nodes)?.id).toBe('inner')
      expect(affected.owningNode('crates/outer/src/lib.rs', nodes)?.id).toBe('outer')
    }
    expect(affected.owningNode('crates/outer-two/x', [outer])).toBeUndefined()
  })
})

describe('the parsers fail closed', () => {
  it('reads the workspace globs and refuses one it does not understand', () => {
    expect(
      affected.parseWorkspaceGlobs('packages:\n  - packages/*\n  - "apps/*"\n\ncatalog:\n  - x\n'),
    ).toEqual(['packages/*', 'apps/*'])
    expect(() => affected.parseWorkspaceGlobs('packages:\n  - packages/**\n')).toThrow(/not a form/)
    expect(() => affected.parseWorkspaceGlobs('catalog:\n  a: b\n')).toThrow(/no packages/)
  })

  it('reads git name-status lines, a tab in the path included', () => {
    expect(affected.parseNameStatus('M\tpackages/a/x.ts\nD\tdocs/b c.md\n\n')).toEqual([
      { status: 'M', path: 'packages/a/x.ts' },
      { status: 'D', path: 'docs/b c.md' },
    ])
  })

  it('refuses an empty selection and a name outside the universe', () => {
    expect(() => affected.validateSelection([], ['a'])).toThrow(/no project is selected/)
    expect(() => affected.validateSelection(['a', 'typo'], ['a', 'b'])).toThrow(/typo/)
    expect(() => affected.validateSelection('a', ['a'])).toThrow(/JSON array/)
    expect(affected.validateSelection(['b', 'a', 'a'], ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('reads a tree name as a path, not a comment or a URL', () => {
    expect(affected.namesTree("const d = join(root, 'docs')", 'docs')).toBe(true)
    expect(affected.namesTree("readFileSync('../../docs/x.md')", 'docs')).toBe(true)
    expect(affected.namesTree("const p = root + '/.claude/rules'", '.claude')).toBe(true)
    expect(affected.namesTree('// see docs/contributing/adr', 'docs')).toBe(false)
    expect(affected.namesTree(' * [ADR](../../docs/adr/1.md)', 'docs')).toBe(false)
    expect(affected.namesTree("const u = 'https://example.com/docs/x'", 'docs')).toBe(false)
    expect(affected.namesTree("const d = 'mydocs'", 'docs')).toBe(false)
  })

  it('splits readers by whether only tests name the tree', () => {
    const files: Record<string, string> = {
      'packages/a/src/x.test.ts': "join(root, 'docs')",
      'packages/b/src/x.test.ts': "join(root, 'docs')",
      'packages/b/src/corpus.ts': "join(root, 'docs')",
      'packages/c/src/y.ts': 'nothing here',
    }
    const readers = affected.scanTreeReaders({
      files: Object.keys(files),
      nodes: [node('a', 'packages/a'), node('b', 'packages/b'), node('c', 'packages/c')],
      read: (path) => files[path] ?? null,
      trees: ['docs'],
    })
    expect(readers.docs).toEqual({ testReaders: ['a'], sourceReaders: ['b'] })
  })
})

// ── The real tree ──────────────────────────────────────────────────────────

const real = affected.readRepoInputs(REPO_ROOT)
const ids = new Set(real.nodes.map((n) => n.id))
const ciJobs = extractWorkflowJobs(
  readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf-8'),
)

describe('every package, project and job is reachable by some rule', () => {
  it('reads a plausible graph and project inventory', () => {
    expect(real.nodes.length).toBeGreaterThan(15)
    expect(ids).toContain('@kamiazya/whiteboard-mcp')
    expect(real.projects.length).toBeGreaterThan(20)
  })

  it('reads a devDependency-only edge out of the manifests', () => {
    // facet-engine declares model under devDependencies alone; the superset
    // test below reads the same graph, so it cannot see a field going unread.
    const facetEngine = real.nodes.find((n) => n.id === '@kamiazya/whiteboard-facet-engine')
    expect(facetEngine?.deps).toContain('@kamiazya/whiteboard-model')
  })

  it('lists only root files that exist and are not configs every package reads', () => {
    for (const file of affected.READ_ROOT_FILES) {
      expect(existsSync(join(REPO_ROOT, file)), file).toBe(true)
      expect(file).not.toMatch(
        /^(package\.json|pnpm-|vitest\.|tsconfig|biome\.json|\.node-version|\.npmrc)/,
      )
    }
  })

  it("selects everything for each file the root vitest config's globalSetup names", () => {
    const setup = [rootConfig.test?.globalSetup ?? []].flat().map((p) => p.replace(/^\.\//, ''))
    expect(setup.length).toBeGreaterThan(0)
    for (const path of setup) {
      const result = affected.planScope({
        changes: [{ path, status: 'M' }],
        event: 'pull_request',
        ...real,
      })
      expect(result.everything, path).toBe(true)
    }
  })

  it('runs mcp-server, whose scripts run them, when a distribution smoke changes', () => {
    const result = affected.planScope({
      changes: [{ path: 'tests/e2e/distribution/smoke-helpers.mjs', status: 'M' }],
      event: 'pull_request',
      ...real,
    })
    expect(result.everything).toBe(false)
    expect(result.affected).toContain('@kamiazya/whiteboard-mcp')
    expect(result.projects).toContain('mcp-node')
  })

  it("runs mcp-server's release-policy tests when release.yml changes", () => {
    const result = affected.planScope({
      changes: [{ path: '.github/workflows/release.yml', status: 'M' }],
      event: 'pull_request',
      ...real,
    })
    expect(result.everything).toBe(false)
    expect(result.projects).toContain('mcp-node')
  })

  it('maps every workspace package to a project or a job, unless its path selects everything', () => {
    const covered = new Set([
      ...real.projects.map((p) => p.node),
      ...Object.values(affected.PACKAGE_JOBS).flatMap((job) => job.packages),
    ])
    const untested = real.nodes.filter(
      (n) =>
        !covered.has(n.id) &&
        !affected.SELECTS_EVERYTHING.some(({ pattern }) => pattern.test(`${n.dir}/package.json`)),
    )
    expect(
      untested.map((n) => n.id),
      'a change to these packages would run none of their tests on a pull request',
    ).toEqual([])
  })

  it('assigns every root vitest project to a scoped job that ci.yml defines', () => {
    const jobIds = new Set(ciJobs.map((job) => job.id))
    for (const p of real.projects) {
      expect(jobIds.has(p.job), `${p.name} -> ${p.job}`).toBe(true)
      expect([...affected.PROJECT_JOBS, 'verify']).toContain(p.job)
    }
  })

  it('puts every ci.yml job in exactly one of the scoped and unscoped tables, and nothing else', () => {
    const tables = [
      affected.PROJECT_JOBS,
      Object.keys(affected.PACKAGE_JOBS),
      Object.keys(affected.PATH_JOBS),
      Object.keys(affected.UNSCOPED_JOBS),
    ]
    for (const job of ciJobs) {
      expect(
        tables.filter((table) => table.includes(job.id)),
        job.id,
      ).toHaveLength(1)
    }
    const declared = tables.flat()
    expect(declared.filter((id) => !ciJobs.some((job) => job.id === id))).toEqual([])
  })

  it('names only real packages in its tables', () => {
    const named = [
      ...Object.values(affected.PACKAGE_JOBS).flatMap((job) => job.packages),
      ...Object.keys(affected.REPO_WIDE_READERS),
      ...Object.keys(affected.TEST_INVENTORY_READERS),
      ...affected.CROSS_PACKAGE_READS.flatMap(({ reader, target }) => [reader, target]),
    ]
    expect(named.filter((id) => !ids.has(id))).toEqual([])
  })

  it('finds the readers it knows exist, so an empty scan is not mistaken for none', () => {
    expect(real.readers.docs?.testReaders).toEqual(
      expect.arrayContaining(['@kamiazya/whiteboard-codec']),
    )
    expect(real.readers.docs?.sourceReaders).toEqual(
      expect.arrayContaining(['@kamiazya/whiteboard-mcp']),
    )
    expect([
      ...(real.readers.skills?.testReaders ?? []),
      ...(real.readers.skills?.sourceReaders ?? []),
    ]).toContain('@kamiazya/whiteboard-mcp')
  })

  it('names only Rust paths that exist, so a scope cannot drift off the tree', () => {
    const scopes = Object.values(affected.PATH_JOBS).map((job) => job.scope)
    expect(scopes.length).toBeGreaterThan(0)
    for (const { files, trees } of scopes) {
      for (const path of [...files, ...trees])
        expect(existsSync(join(REPO_ROOT, path)), path).toBe(true)
    }
  })

  it('runs the Rust jobs, and not the TS matrix, for a crate change on the real tree', () => {
    const result = affected.planScope({
      changes: [{ path: 'crates/core/det/src/lib.rs', status: 'M' }],
      event: 'pull_request',
      ...real,
    })
    expect(result.everything, result.reasons.join('\n')).toBe(false)
    expect(result.jobs.rust?.run).toBe(true)
    expect(result.jobs['rust-fuzz-pr']?.run).toBe(true)
    for (const id of ['test-unit', 'test-jsdom', 'test-browser', 'widget-smoke']) {
      expect(result.jobs[id]?.run, id).toBe(false)
    }
  })

  it("still has apps/web's test-file inventory, the reason TEST_INVENTORY_READERS exists", () => {
    const ledger = readFileSync(
      join(REPO_ROOT, 'apps/web/src/test-utils/coverage-ledger.ts'),
      'utf-8',
    )
    expect(ledger).toMatch(/import\.meta\.glob\([^)]*\*\*\/\*\.test\./)
  })
})

describe('a change to any package selects every package that depends on it', () => {
  // The oracle walks FORWARD from each package through its dependencies, the
  // opposite direction to the closure under test, so a bug in the reverse
  // index cannot be shared by both.
  const byId = new Map(real.nodes.map((n) => [n.id, n]))
  const dependsOn = (from: string, to: string): boolean => {
    const seen = new Set<string>()
    const stack = [...(byId.get(from)?.deps ?? [])]
    while (stack.length > 0) {
      const id = stack.pop() as string
      if (id === to) return true
      if (seen.has(id)) continue
      seen.add(id)
      stack.push(...(byId.get(id)?.deps ?? []))
    }
    return false
  }

  it('reaches at least one real dependent edge', () => {
    const pairs = real.nodes.flatMap((a) => real.nodes.filter((b) => dependsOn(b.id, a.id)))
    expect(pairs.length).toBeGreaterThan(30)
  })

  it.each(real.nodes.map((n) => [n.id, n] as const))('%s', (_id, changed) => {
    const result = affected.planScope({
      changes: [{ path: `${changed.dir}/src/index.ts`, status: 'M' }],
      event: 'pull_request',
      ...real,
    })
    if (result.everything) return // its path selects everything; nothing narrower to check
    const needed = real.projects
      .filter((p) => p.node === changed.id || dependsOn(p.node, changed.id))
      .map((p) => p.name)
    expect(result.projects).toEqual(expect.arrayContaining(needed))
    for (const [jobId, { packages }] of Object.entries(affected.PACKAGE_JOBS)) {
      if (packages.some((id) => id === changed.id || dependsOn(id, changed.id))) {
        expect(result.jobs[jobId]?.run, jobId).toBe(true)
      }
    }
  })
})

// ── ci.yml wires every scoped job the same way ─────────────────────────────

interface YamlStep {
  name?: string
  uses?: string
  if?: string
  run?: string
  with?: Record<string, unknown>
}

const workflow = parseYaml(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf-8')) as {
  jobs: Record<string, { steps?: YamlStep[] }>
}
const SCOPED = [
  ...affected.PROJECT_JOBS,
  ...Object.keys(affected.PACKAGE_JOBS),
  ...Object.keys(affected.PATH_JOBS),
]
const NOT_AFFECTED = 'Not affected by this change'

describe('every scoped job skips its work on its own detection, and only then', () => {
  it.each(SCOPED)('%s', (id) => {
    const steps = workflow.jobs[id]?.steps ?? []
    const at = steps.findIndex((step) => step.name === 'Detect change scope')
    expect(at, `${id} has no Detect change scope step`).toBeGreaterThan(0)
    // Its own id, so a copied block cannot detect for another job.
    expect(steps[at]?.run).toMatch(new RegExp(`affected-cli\\.mjs job ${id} --event "\\$EVENT"$`))
    const checkout = steps.slice(0, at).find((step) => step.uses?.startsWith('actions/checkout@'))
    expect(Number(checkout?.with?.['fetch-depth']), `${id} needs HEAD^1`).toBeGreaterThanOrEqual(2)

    const skip = steps.find((step) => step.name === NOT_AFFECTED)
    expect(skip?.if).toBe("steps.scope.outputs.run != 'true'")

    // Every step after detection is gated on it, except the skip notice and
    // a failure upload (which cannot fire on a job that ran nothing).
    const ungated = steps
      .slice(at + 1)
      .filter((step) => step.name !== NOT_AFFECTED && !(step.if ?? '').includes('failure()'))
      .filter((step) => !/steps\.scope\.outputs\.(run == 'true'|projects)/.test(step.if ?? ''))
      .map((step) => step.name ?? step.uses)
    expect(ungated, `${id}: these steps run even when the change does not reach the job`).toEqual(
      [],
    )
  })

  it('no unscoped job carries a detection or a skip it is never judged by', () => {
    for (const id of Object.keys(affected.UNSCOPED_JOBS)) {
      const names = (workflow.jobs[id]?.steps ?? []).map((step) => step.name)
      expect(names, id).not.toContain('Detect change scope')
      expect(names, id).not.toContain(NOT_AFFECTED)
    }
  })

  it('names its skip step exactly as ci-gate reads it', () => {
    expect(gate.NOT_AFFECTED_STEP).toBe(NOT_AFFECTED)
  })
})

describe('the scoped vitest jobs run the universes the rest of CI names', () => {
  it("test-shared's universe is the derived shared-layer list", () => {
    expect(affected.jobUniverse('test-shared', real.projects)).toEqual(
      vitestProjects.deriveSharedLayerProjectNames(REPO_ROOT),
    )
  })

  it("test-browser's universe is every browser-mode project, which test:browser lists", () => {
    const universe = affected.jobUniverse('test-browser', real.projects)
    expect(universe).toEqual([...vitestProjects.readBrowserProjectNames(REPO_ROOT)].sort())
    const script =
      (
        JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
          scripts: Record<string, string>
        }
      ).scripts['test:browser'] ?? ''
    const listed = [...script.matchAll(/--project (\S+)/g)].map((m) => m[1]).sort()
    expect(listed).toEqual(universe)
  })
})
