#!/usr/bin/env node

// @whiteboard/checks — which tests and CI jobs a change needs.
//
// Changed files -> the workspace nodes they touch -> the reverse-dependency
// closure of those nodes -> the vitest projects and ci.yml jobs that must run.
// Everything a pull request does not reach is skipped INSIDE its job, so every
// job still reports and `ci-gate` still judges it (see ci.yml's `scope` job).
//
// Three rules hold the selection to "never less than the change needs":
//
//   - FAIL CLOSED. A changed path this module cannot attribute to a node —
//     a root config, the lockfile, a workflow, the CI scripts themselves, an
//     unknown top-level directory — selects everything. So does any error
//     while computing the answer. A needless full run costs minutes; a
//     silently skipped suite costs a red main.
//   - SELECTION IS FOR PULL REQUESTS ONLY. A push to main, a merge-queue run,
//     a dispatch or a schedule run everything, because each is the last check
//     before a release tag can point at the commit.
//   - DERIVED, NOT LISTED. Nodes come from the workspace manifests, projects
//     from vitest.projects.json, and which node reads a non-package tree from
//     a scan of its source. The hand-written tables below are the few facts no
//     manifest carries, each held to the tree by a guard in tools/arch-lint
//     (affected.test.ts).
//
// tools/checks stays dependency-free (see release-gate-matrix-schema.mjs): the
// CI step that runs this has not installed anything yet, and skipping the
// install is half of what a skip saves.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECTS_RUN_ELSEWHERE, readVitestProjects } from './vitest-projects.mjs'

// ── What selects everything ────────────────────────────────────────────────

/**
 * Paths whose change selects every project and every job, each with why.
 * Checked BEFORE node attribution, so a node that lives under one of these
 * (tools/checks is a workspace package) still selects everything.
 */
export const SELECTS_EVERYTHING = [
  {
    // Every root-level file but the documents and metadata READ_ROOT_FILES
    // names: the lockfile, the root manifest, the vitest, tsconfig and biome
    // configs, .node-version, .npmrc, the Dockerfile.
    pattern: {
      test: (path) =>
        /^[^/]+$/.test(path) && !READ_ROOT_FILES.includes(path) && pathJobsOf(path).length === 0,
    },
    why: 'a root-level build, install or test config reaches every package',
  },
  {
    pattern: /^\.github\/(?:workflows\/ci\.yml|actions\/)/,
    why: 'ci.yml and the actions it runs are CI itself',
  },
  { pattern: /^tools\/checks\//, why: 'the CI scripts, this selection among them' },
  { pattern: /^tools\/biome-plugins\//, why: 'lint rules applied to every package' },
  { pattern: /^tools\/[^/]+$/, why: 'a loose tools/ script' },
  { pattern: /^patches\//, why: 'a dependency patch, installed into every package' },
  {
    pattern: /^\.claude\/scripts\/node-version-banner\.mjs$/,
    why: "the root vitest config's globalSetup, which runs for every project",
  },
]

/**
 * Top-level trees no package owns but packages READ — the docs a test holds
 * code to, the rules and skills a guard scans, the workflows a release-policy
 * test parses, the distribution smokes mcp-server's scripts run. A change
 * under one selects the nodes whose source names the tree
 * (`scanTreeReaders`). Any other unowned path is unattributable and selects
 * everything.
 */
export const READ_TREES = ['docs', '.claude', 'skills', '.github', 'tests']

/**
 * Root-level files that build, install and run nothing: documents and the
 * metadata of tools CI runs whole either way (knip, lefthook, release-please,
 * secretlint, sonar). A change to one selects the nodes whose source names
 * it, like a READ_TREES entry. A root file not listed here selects everything.
 */
export const READ_ROOT_FILES = [
  'AGENTS.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'README.md',
  'SECURITY.md',
  '.env.server.example',
  '.mcp.json',
  '.pinact.yaml',
  '.release-please-manifest.json',
  '.secretlintignore',
  '.secretlintrc.json',
  'docker-compose.server.yml',
  'gemini-extension.json',
  'knip.jsonc',
  'lefthook.yml',
  'release-please-config.json',
  'server.json',
  'sonar-project.properties',
]

/**
 * Nodes whose tests read the whole repository — every package's source, the
 * docs, the workflows — so their projects run on every change. Without this
 * the guard that a change breaks is the one guard that does not run.
 * @type {Record<string, string>}
 */
export const REPO_WIDE_READERS = {
  '@kamiazya/whiteboard-arch-lint':
    "arch-lint's guards read every package's source, the docs and the workflows",
}

/**
 * A test that imports another workspace's file by a relative path, which no
 * manifest records. A change to `target` runs `reader`'s own projects. Held to
 * relative-import-escape.test.ts's ledger, which lists every such import.
 * @type {{ reader: string, target: string, why: string }[]}
 */
export const CROSS_PACKAGE_READS = [
  {
    reader: '@kamiazya/whiteboard-mcp',
    target: '@kamiazya/whiteboard-arch-lint',
    why: "mcp-server's release-policy tests import arch-lint's job-section helper",
  },
]

/**
 * Nodes whose tests list every test FILE in the repository by name, so adding
 * or deleting one anywhere can change their result.
 * @type {Record<string, string>}
 */
export const TEST_INVENTORY_READERS = {
  '@kamiazya/whiteboard-web':
    "apps/web's coverage-ledger helper globs every *.test.{ts,tsx} under apps, packages and tools",
}

// ── Which jobs a selection runs ────────────────────────────────────────────

/**
 * ci.yml jobs that run the vitest projects assigned to them. A project's job
 * is DERIVED: PROJECTS_RUN_ELSEWHERE names the ones with a job of their own,
 * a browser-mode project runs in `test-browser`, and every other project is
 * `test-shared`'s. Such a job runs when its selection is not empty.
 */
export const PROJECT_JOBS = ['test-unit', 'test-shared', 'test-jsdom', 'test-browser']

/**
 * ci.yml jobs that exercise built packages rather than vitest projects. Each
 * runs when any of its packages is in the affected closure — which includes
 * every package they depend on, since the closure walks dependents.
 * @type {Record<string, { packages: string[], why: string }>}
 */
export const PACKAGE_JOBS = {
  'widget-smoke': {
    packages: ['@kamiazya/whiteboard-canvas-viewer'],
    why: "canvas-viewer's self-contained widget build",
  },
  'extension-smokes': {
    packages: [
      '@kamiazya/whiteboard-extension',
      '@kamiazya/whiteboard-web',
      '@kamiazya/whiteboard-mcp',
    ],
    why: 'the built extension and web app against a real daemon',
  },
  'native-host-windows': {
    packages: ['@kamiazya/whiteboard-extension', '@kamiazya/whiteboard-mcp'],
    why: "the native host and the daemon's named pipe on Windows",
  },
}

/**
 * The Cargo workspace's files at the root and the trees under it. A change
 * here builds and tests no pnpm package, so it is attributed to the Rust jobs
 * instead of selecting everything. The Rust CI scripts
 * (tools/checks/src/rust-*.mjs) are not listed: tools/checks selects
 * everything, the Rust jobs with it.
 */
const RUST_SCOPE = {
  files: ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'rustfmt.toml', 'deny.toml'],
  trees: ['.cargo', 'crates', 'contracts', 'packages/canvas-render/src/generated'],
}

/**
 * ci.yml jobs scoped by PATH rather than by the workspace graph: each runs
 * when a changed path is one of its scope's root files or lies under one of
 * its trees. The Cargo workspace is not a pnpm node, and modelling its crates
 * as graph nodes would buy nothing yet — both jobs build the whole workspace.
 * A TS package whose source names one of these paths still runs, through
 * scanTreeReaders, as for any READ_TREES entry.
 * @type {Record<string, { scope: { files: string[], trees: string[] }, why: string }>}
 */
export const PATH_JOBS = {
  rust: { scope: RUST_SCOPE, why: 'pnpm rust:check, the wasm build and the release gates' },
  'rust-fuzz-pr': {
    scope: RUST_SCOPE,
    why: 'the fuzz targets whose crates changed, for tens of seconds each',
  },
}

/**
 * The PATH_JOBS whose scope holds `path`.
 * @param {string} path
 * @returns {string[]}
 */
function pathJobsOf(path) {
  return Object.entries(PATH_JOBS)
    .filter(
      ([, { scope }]) =>
        scope.files.includes(path) || scope.trees.some((tree) => path.startsWith(`${tree}/`)),
    )
    .map(([id]) => id)
}

/** The root files and trees every PATH_JOBS scope names, for the reader scan. */
function pathJobTrees() {
  const scopes = Object.values(PATH_JOBS).map(({ scope }) => scope)
  return [...new Set(scopes.flatMap(({ files, trees }) => [...files, ...trees]))]
}

/**
 * ci.yml jobs that run on every event whatever the change, each with why.
 * Every job in ci.yml is in exactly one of PROJECT_JOBS, PACKAGE_JOBS,
 * PATH_JOBS and this.
 * @type {Record<string, string>}
 */
export const UNSCOPED_JOBS = {
  scope: 'computes the selection itself',
  check: 'lint, typecheck, audit and secret scan read the whole workspace',
  verify: 'knip and the build read the whole workspace; mcp-smoke rides along',
  'stress-changed-tests': 'already selects by the changed test files themselves',
  'dry-run-docker': 'already selects by docker-build-inputs.mjs',
  'sbom-npm':
    'a release gate the release-gate matrix pins as unconditional pull-request coverage (gate-isomorphism.test.ts), and off the wall-clock path',
  'packaged-smoke':
    'a release gate the release-gate matrix pins as unconditional pull-request coverage (gate-isomorphism.test.ts), and off the wall-clock path',
  zizmor: 'audits the workflow files, which are CI itself',
  'dependency-review':
    'reads the dependency-graph diff GitHub computes between base and head, not a workspace path',
  'ci-gate': 'the aggregate check',
}

// ── The graph ──────────────────────────────────────────────────────────────

/**
 * One node of the change graph. `source` names the ecosystem that produced
 * it; nothing below reads it, which is the point — a Cargo crate is a node
 * with a dir and deps like any package, and the closure walks it the same.
 *
 * @typedef {{ id: string, dir: string, deps: string[], source: string }} GraphNode
 */

const WORKSPACE_DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]

/**
 * The `packages:` globs of pnpm-workspace.yaml. Only `dir/*` and a plain
 * directory are understood; anything else throws, which the CLI turns into a
 * full run.
 * @param {string} yamlText
 * @returns {string[]}
 */
export function parseWorkspaceGlobs(yamlText) {
  const globs = []
  let inPackages = false
  for (const line of yamlText.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true
      continue
    }
    if (!inPackages) continue
    if (/^\S/.test(line)) break
    const entry = line.match(/^\s+-\s+['"]?([^'"\s#]+)['"]?\s*(#.*)?$/)
    if (entry) {
      if (!/^[\w.-]+(\/[\w.-]+)*(\/\*)?$/.test(entry[1])) {
        throw new Error(`pnpm-workspace.yaml glob \`${entry[1]}\` is not a form affected.mjs reads`)
      }
      globs.push(entry[1])
    }
  }
  if (globs.length === 0) throw new Error('pnpm-workspace.yaml declares no packages')
  return globs
}

/**
 * The pnpm workspace as graph nodes: one per manifest the workspace globs
 * reach, its edges every `workspace:` dependency in any dependency field —
 * dev dependencies included, since a test importing a devDependency breaks
 * with it.
 * @param {string} repoRoot
 * @returns {GraphNode[]}
 */
export function readPnpmWorkspaceNodes(repoRoot) {
  const globs = parseWorkspaceGlobs(readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'))
  const dirs = globs.flatMap((glob) => {
    if (!glob.endsWith('/*')) return [glob]
    const parent = glob.slice(0, -2)
    if (!existsSync(join(repoRoot, parent))) return []
    return readdirSync(join(repoRoot, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`)
  })
  return dirs
    .filter((dir) => existsSync(join(repoRoot, dir, 'package.json')))
    .map((dir) => {
      const manifest = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8'))
      const deps = WORKSPACE_DEP_FIELDS.flatMap((field) =>
        Object.entries(manifest[field] ?? {})
          .filter(([, range]) => typeof range === 'string' && range.startsWith('workspace:'))
          .map(([name]) => name),
      )
      return { id: manifest.name ?? dir, dir, deps: [...new Set(deps)].sort(), source: 'pnpm' }
    })
    .sort((a, b) => a.dir.localeCompare(b.dir))
}

/**
 * Where nodes come from. A second ecosystem is a second entry returning the
 * same GraphNode shape — for a Cargo workspace, `cargo metadata
 * --no-deps --format-version 1`'s `packages` (id = package name, dir = the
 * manifest's directory, deps = path dependencies). Its tests then need a
 * project source beside vitest.projects.json and a job that runs them; the
 * selection and the closure need no change.
 * @type {{ name: string, read: (repoRoot: string) => GraphNode[] }[]}
 */
export const GRAPH_SOURCES = [{ name: 'pnpm', read: readPnpmWorkspaceNodes }]

/**
 * @param {string} repoRoot
 * @param {typeof GRAPH_SOURCES} [sources]
 * @returns {GraphNode[]}
 */
export function readGraph(repoRoot, sources = GRAPH_SOURCES) {
  const nodes = sources.flatMap((source) => source.read(repoRoot))
  const ids = new Set()
  for (const node of nodes) {
    if (ids.has(node.id)) throw new Error(`two graph nodes share the id ${node.id}`)
    ids.add(node.id)
  }
  return nodes
}

/**
 * The given nodes and every node that depends on one of them, transitively.
 * @param {string[]} roots node ids
 * @param {GraphNode[]} nodes
 * @returns {string[]} sorted ids
 */
export function dependentsClosure(roots, nodes) {
  /** @type {Map<string, string[]>} */
  const dependents = new Map()
  for (const node of nodes) {
    for (const dep of node.deps) dependents.set(dep, [...(dependents.get(dep) ?? []), node.id])
  }
  const seen = new Set()
  const queue = [...roots]
  while (queue.length > 0) {
    const id = /** @type {string} */ (queue.pop())
    if (seen.has(id)) continue
    seen.add(id)
    queue.push(...(dependents.get(id) ?? []))
  }
  return [...seen].sort()
}

/**
 * The node a path belongs to: the one with the longest directory prefix.
 * @param {string} path
 * @param {GraphNode[]} nodes
 * @returns {GraphNode | undefined}
 */
export function owningNode(path, nodes) {
  let best
  for (const node of nodes) {
    if (path.startsWith(`${node.dir}/`) && (!best || node.dir.length > best.dir.length)) best = node
  }
  return best
}

// ── Who reads a non-package tree ───────────────────────────────────────────

const SCANNED_SOURCE = /\.(?:[cm]?[jt]sx?|json)$/
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

/**
 * Whether a source text names `tree` as a path: `'docs'`, `'docs/…'`,
 * `'../../docs/…'` or `…/docs/…` inside a string. Lines that START as a
 * comment are dropped first, and URLs with them — a JSDoc pointing at an ADR
 * is not a read. A trailing comment is kept: over-reading costs a few extra
 * projects, under-reading a skipped suite.
 * @param {string} text
 * @param {string} tree
 */
export function namesTree(text, tree) {
  const code = text
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
    .replace(/https?:\/\/[^\s'"`)]+/g, '')
  const escaped = tree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`['"\`/]${escaped}(?:/|['"\`])`).test(code)
}

/**
 * For each READ_TREES and READ_ROOT_FILES entry, the nodes whose files name it — split by whether
 * only TEST files do. A test-only reader runs its own projects when the tree
 * changes; a node whose shipped source, script, config or test-utils names it
 * counts as touched, so its dependents run too.
 *
 * @param {{ files: string[], nodes: GraphNode[], read: (path: string) => string | null, trees?: string[] }} input
 * @returns {Record<string, { testReaders: string[], sourceReaders: string[] }>}
 */
export function scanTreeReaders({
  files,
  nodes,
  read,
  trees = [...READ_TREES, ...READ_ROOT_FILES, ...pathJobTrees()],
}) {
  /** @type {Record<string, { test: Set<string>, source: Set<string> }>} */
  const found = Object.fromEntries(
    trees.map((tree) => [tree, { test: new Set(), source: new Set() }]),
  )
  for (const file of files) {
    if (!SCANNED_SOURCE.test(file)) continue
    const node = owningNode(file, nodes)
    if (!node) continue
    const text = read(file)
    if (text === null) continue
    for (const tree of trees) {
      if (!namesTree(text, tree)) continue
      found[tree][TEST_FILE.test(file) ? 'test' : 'source'].add(node.id)
    }
  }
  return Object.fromEntries(
    Object.entries(found).map(([tree, { test, source }]) => [
      tree,
      {
        testReaders: [...test].filter((id) => !source.has(id)).sort(),
        sourceReaders: [...source].sort(),
      },
    ]),
  )
}

// ── Projects and jobs ──────────────────────────────────────────────────────

/**
 * @typedef {{ name: string, configPath: string, isBrowser: boolean, node: string, job: string }} Project
 */

/**
 * The root vitest projects, each with the node that owns its config and the
 * ci.yml job that runs it.
 * @param {{ configPath: string, name: string | undefined, isBrowser: boolean }[]} vitestProjects
 * @param {GraphNode[]} nodes
 * @returns {Project[]}
 */
export function attributeProjects(vitestProjects, nodes) {
  return vitestProjects.map((project) => {
    if (!project.name) throw new Error(`${project.configPath} declares no test.name`)
    const node = owningNode(project.configPath, nodes)
    if (!node) throw new Error(`${project.configPath} lies in no workspace node`)
    const job =
      PROJECTS_RUN_ELSEWHERE[project.configPath]?.job ??
      (project.isBrowser ? 'test-browser' : 'test-shared')
    return {
      name: project.name,
      configPath: project.configPath,
      isBrowser: project.isBrowser,
      node: node.id,
      job,
    }
  })
}

/**
 * Every project a job could run, in name order.
 * @param {string} jobId
 * @param {Project[]} projects
 */
export function jobUniverse(jobId, projects) {
  return projects
    .filter((project) => project.job === jobId)
    .map((project) => project.name)
    .sort()
}

/**
 * @typedef {{ path: string, status: string }} Change  status is git's letter: A, D, M, T…
 * @typedef {{ run: boolean, projects: string[] | null, reason: string }} JobPlan
 * @typedef {{
 *   everything: boolean,
 *   reasons: string[],
 *   touched: string[],
 *   affected: string[],
 *   projects: string[],
 *   jobs: Record<string, JobPlan>,
 * }} Plan
 */

/**
 * What one changed path does to the selection: select everything (with why),
 * touch a node, or run some nodes' own projects.
 * @param {Change} change
 * @param {GraphNode[]} nodes
 * @param {Record<string, { testReaders: string[], sourceReaders: string[] }>} readers
 * @returns {{ everything?: string, touch: string[], own: string[], changed?: string }}
 */
function attributeChange({ path, status }, nodes, readers) {
  const failClosed = SELECTS_EVERYTHING.find(({ pattern }) => pattern.test(path))
  if (failClosed) return { everything: `${path}: ${failClosed.why}`, touch: [], own: [] }
  const node = owningNode(path, nodes)
  if (node) {
    const listsTests = TEST_FILE.test(path) && (status === 'A' || status === 'D')
    return {
      touch: [node.id],
      own: listsTests ? Object.keys(TEST_INVENTORY_READERS) : [],
      changed: node.id,
    }
  }
  if (pathJobsOf(path).length > 0) {
    // Scheduled by pathHitsOf; here only the TS packages that read the path.
    const tree = pathJobTrees().find((name) => path === name || path.startsWith(`${name}/`))
    const read = (tree && readers[tree]) || { sourceReaders: [], testReaders: [] }
    return { touch: read.sourceReaders, own: read.testReaders }
  }
  const tree = READ_ROOT_FILES.includes(path)
    ? path
    : READ_TREES.find((name) => path.startsWith(`${name}/`))
  if (tree && readers[tree]) {
    return { touch: readers[tree].sourceReaders, own: readers[tree].testReaders }
  }
  return {
    everything: `${path}: no workspace node owns it and no rule attributes it`,
    touch: [],
    own: [],
  }
}

/**
 * @param {boolean} everything
 * @param {string[]} hit
 * @param {string[]} universe
 * @param {string} verb
 */
function jobReason(everything, hit, universe, verb) {
  if (everything) return 'everything selected'
  if (hit.length > 0) return `${verb}: ${hit.join(', ')}`
  return `none of ${universe.join(', ')} is affected`
}

/**
 * @param {{ everything: boolean, projects: Project[], selected: Set<string>, affected: Set<string>, pathHits: Map<string, string[]> }} input
 * @returns {Record<string, JobPlan>}
 */
function planJobs({ everything, projects, selected, affected, pathHits }) {
  /** @type {Record<string, JobPlan>} */
  const jobs = {}
  for (const jobId of PROJECT_JOBS) {
    const universe = jobUniverse(jobId, projects)
    const picked = universe.filter((name) => selected.has(name))
    jobs[jobId] = {
      run: everything || picked.length > 0,
      projects: picked,
      reason: jobReason(everything, picked, universe, 'selected'),
    }
  }
  for (const [jobId, { packages }] of Object.entries(PACKAGE_JOBS)) {
    const hit = packages.filter((id) => affected.has(id))
    jobs[jobId] = {
      run: everything || hit.length > 0,
      projects: null,
      reason: jobReason(everything, hit, packages, 'affected'),
    }
  }
  return { ...jobs, ...planPathJobs(everything, pathHits) }
}

/**
 * @param {boolean} everything
 * @param {Map<string, string[]>} pathHits changed paths per PATH_JOBS id
 * @returns {Record<string, JobPlan>}
 */
function planPathJobs(everything, pathHits) {
  return Object.fromEntries(
    Object.entries(PATH_JOBS).map(([jobId, { scope }]) => {
      const hit = pathHits.get(jobId) ?? []
      return [
        jobId,
        {
          run: everything || hit.length > 0,
          projects: null,
          reason: pathJobReason(everything, hit, scope),
        },
      ]
    }),
  )
}

/**
 * @param {boolean} everything
 * @param {string[]} hit
 * @param {{ files: string[], trees: string[] }} scope
 */
function pathJobReason(everything, hit, scope) {
  if (everything) return 'everything selected'
  if (hit.length > 5) return `changed: ${hit.slice(0, 5).join(', ')} and ${hit.length - 5} more`
  if (hit.length > 0) return `changed: ${hit.join(', ')}`
  return `none of ${[...scope.files, ...scope.trees.map((tree) => `${tree}/`)].join(', ')} changed`
}

/**
 * The changed paths each PATH_JOBS job is scoped to.
 * @param {Change[]} changes
 * @returns {Map<string, string[]>}
 */
function pathHitsOf(changes) {
  /** @type {Map<string, string[]>} */
  const hits = new Map()
  for (const { path } of changes) {
    for (const id of pathJobsOf(path)) hits.set(id, [...(hits.get(id) ?? []), path])
  }
  return hits
}

/**
 * Fold every change's attribution into the sets planScope reads.
 * @param {Change[]} changes
 * @param {GraphNode[]} nodes
 * @param {Record<string, { testReaders: string[], sourceReaders: string[] }>} readers
 */
function attributeChanges(changes, nodes, readers) {
  const touched = new Set()
  /** Nodes a changed file lies inside, as opposed to nodes that read a changed tree. */
  const changedNodes = new Set()
  /** Nodes whose own projects run, without their dependents. */
  const ownProjectsOf = new Set(Object.keys(REPO_WIDE_READERS))
  /** @type {string[]} */
  const failClosed = []
  for (const change of changes) {
    const { everything, touch, own, changed } = attributeChange(change, nodes, readers)
    if (everything) failClosed.push(everything)
    for (const id of touch) touched.add(id)
    for (const id of own) ownProjectsOf.add(id)
    if (changed) changedNodes.add(changed)
  }
  for (const { reader, target } of CROSS_PACKAGE_READS) {
    if (changedNodes.has(target)) ownProjectsOf.add(reader)
  }
  return { touched, ownProjectsOf, failClosed }
}

/**
 * The selection for one change.
 *
 * @param {{
 *   changes: Change[],
 *   event: string,
 *   nodes: GraphNode[],
 *   projects: Project[],
 *   readers: Record<string, { testReaders: string[], sourceReaders: string[] }>,
 * }} input
 * @returns {Plan}
 */
export function planScope({ changes, event, nodes, projects, readers }) {
  /** @type {string[]} */
  const everythingBecause =
    event === 'pull_request'
      ? []
      : [`a ${event} run selects everything; selection is for pull requests`]
  const { touched, ownProjectsOf, failClosed } = attributeChanges(changes, nodes, readers)
  everythingBecause.push(...failClosed)

  const everything = everythingBecause.length > 0
  const affected = everything
    ? nodes.map((node) => node.id).sort()
    : dependentsClosure([...touched], nodes)
  const affectedSet = new Set(affected)
  const selected = projects
    .filter((p) => everything || affectedSet.has(p.node) || ownProjectsOf.has(p.node))
    .map((p) => p.name)
    .sort()

  return {
    everything,
    reasons: everything
      ? everythingBecause
      : [`touched: ${[...touched].sort().join(', ') || '(no workspace node)'}`],
    touched: [...touched].sort(),
    affected,
    projects: selected,
    jobs: planJobs({
      everything,
      projects,
      selected: new Set(selected),
      affected: affectedSet,
      pathHits: pathHitsOf(changes),
    }),
  }
}

/**
 * A job's plan when the selection could not be computed: run, with the whole
 * universe. The fail-closed answer, kept in one place so every caller gives it.
 * @param {string} jobId
 * @param {Project[] | null} projects
 * @param {string} why
 * @returns {JobPlan}
 */
export function failOpenJob(jobId, projects, why) {
  return {
    run: true,
    projects: PROJECT_JOBS.includes(jobId) && projects ? jobUniverse(jobId, projects) : null,
    reason: `selection unavailable, running everything: ${why}`,
  }
}

/**
 * The `--project` names a runner may hand vitest for one job: refuses an
 * empty list and any name outside the job's universe, since vitest silently
 * drops a name that matches nothing as long as another one does.
 * @param {unknown} selected
 * @param {string[]} universe
 * @returns {string[]}
 */
export function validateSelection(selected, universe) {
  if (!Array.isArray(selected) || !selected.every((name) => typeof name === 'string')) {
    throw new Error('the selected projects are not a JSON array of names')
  }
  if (selected.length === 0) {
    throw new Error('no project is selected; the step should have been skipped, not run empty')
  }
  const unknown = selected.filter((name) => !universe.includes(name))
  if (unknown.length > 0) {
    throw new Error(
      `selected project(s) ${unknown.join(', ')} are not in this job's universe (${universe.join(', ')})`,
    )
  }
  return [...new Set(selected)].sort()
}

// ── Reading a change from git ──────────────────────────────────────────────

/**
 * @param {string} nameStatus `git diff --name-status --no-renames` output
 * @returns {Change[]}
 */
export function parseNameStatus(nameStatus) {
  return nameStatus
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [status, ...rest] = line.split('\t')
      return { status: status.charAt(0), path: rest.join('\t') }
    })
}

/**
 * Everything planScope needs that is read off the tree at `repoRoot`.
 * @param {string} repoRoot
 */
export function readRepoInputs(repoRoot) {
  const nodes = readGraph(repoRoot)
  const projects = attributeProjects(readVitestProjects(repoRoot), nodes)
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  const readers = scanTreeReaders({
    files,
    nodes,
    read: (path) => {
      try {
        const full = join(repoRoot, path)
        // A generated bundle or a recorded fixture is not where a read lives.
        if (statSync(full).size > 512 * 1024) return null
        return readFileSync(full, 'utf8')
      } catch {
        return null
      }
    },
  })
  return { nodes, projects, readers }
}
