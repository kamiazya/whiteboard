// @whiteboard/checks — root vitest.config.ts project inventory + the
// shared-layer step's derivation.
//
// tools/checks stays dependency-free (see release-gate-matrix-schema.mjs), so
// this is a regex scan over the config text rather than a real module
// evaluation of vitest.config.ts.
//
// This is the single parser: ci-verify-coverage.test.ts, docs-contract.test.ts,
// and run-shared-layer-tests.mjs (the CI-invoked derivation) all read the same
// inventory instead of each holding a copy that can drift apart.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @typedef {{ configPath: string, name: string | undefined, isBrowser: boolean }} VitestProject
 * @typedef {{ job: string, mechanism: 'flag' | 'filter-script', marker: string }} ElsewhereEntry
 */

// Every vitest project root vitest.config.ts wires up. The path regex matches
// any quoted `*.config.ts` rather than a `packages|apps` prefix, so tools/
// projects (tools/arch-lint) are included too.
/**
 * @param {string} repoRoot
 * @returns {VitestProject[]}
 */
export function readVitestProjects(repoRoot) {
  const rootVitestConfig = readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8')
  const configPaths = [...rootVitestConfig.matchAll(/'([^']+\.config\.ts)'/g)].map(
    (match) => match[1],
  )
  return configPaths.map((configPath) => {
    const configContent = readFileSync(join(repoRoot, configPath), 'utf8')
    return {
      configPath,
      name: configContent.match(/name:\s*'([^']+)'/)?.[1],
      // Two shapes count as browser-enabled: the inline literal, and the
      // shared factory every browser config spreads since the dedupe —
      // sharedBrowserTestConfig() always sets enabled: true, so its call
      // site is as reliable a marker as the literal it replaced.
      isBrowser:
        /browser:\s*\{\s*\n?\s*enabled:\s*true/.test(configContent) ||
        /browser:\s*sharedBrowserTestConfig\(/.test(configContent),
    }
  })
}

// Names of the vitest projects with `browser.enabled: true`. This is the
// shared ground truth that docs-contract.test.ts (docs enumeration) and
// ci-verify-coverage.test.ts (package.json test:browser script) each check
// their own surface against, so none of the three can drift apart silently.
/**
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function readBrowserProjectNames(repoRoot) {
  return readVitestProjects(repoRoot)
    .filter((project) => project.isBrowser)
    .map((project) => {
      if (!project.name) {
        throw new Error(`${project.configPath} enables browser mode but declares no test.name`)
      }
      return project.name
    })
}

// Config paths whose vitest project is exercised by CI through a mechanism
// other than the derived shared-layer step, keyed by the CONFIG PATH (not the
// project name) so a later rename of the project's `test.name` cannot
// silently invalidate the exemption. This set is stable by construction (each
// entry owns a dedicated CI step for a reason — sharding, a distinct job, or a
// `pnpm --filter` script that runs more than one vitest config) while the
// derived list below grows with every new shared-layer package, which is the
// whole point of deriving instead of hand-listing.
/** @type {Record<string, ElsewhereEntry>} */
export const PROJECTS_RUN_ELSEWHERE = {
  // Largest suite; sharded 2-way across test-unit's matrix instead of run
  // once alongside the rest.
  'packages/mcp-server/vitest.node.config.ts': {
    job: 'test-unit',
    mechanism: 'flag',
    marker: '--project=mcp-node',
  },
  // Spawns the real MCP stdio server; runs in the verify job only, after a
  // build, not in test-unit.
  'packages/mcp-server/vitest.smoke.config.ts': {
    job: 'verify',
    mechanism: 'flag',
    marker: '--project=mcp-smoke',
  },
  // Small but given its own test-unit step so canvas-viewer coverage reads as
  // one block in CI logs; not folded into the shared-layer step.
  'packages/canvas-viewer/vitest.node.config.ts': {
    job: 'test-unit',
    mechanism: 'flag',
    marker: '--project=canvas-viewer-node',
  },
  'packages/canvas-viewer/vitest.jsdom.config.ts': {
    job: 'test-unit',
    mechanism: 'flag',
    marker: '--project=canvas-viewer-jsdom',
  },
  // test-jsdom job: `pnpm --filter @kamiazya/whiteboard-web test` is
  // `vitest run && vitest run --config vitest.node.config.ts` — it runs both
  // of these by config path, never by --project flag.
  'apps/web/vitest.config.ts': {
    job: 'test-jsdom',
    mechanism: 'filter-script',
    marker: 'whiteboard-web test',
  },
  'apps/web/vitest.node.config.ts': {
    job: 'test-jsdom',
    mechanism: 'filter-script',
    marker: 'whiteboard-web test',
  },
}

// The shared-layer step's project list: every non-browser project registered
// in root vitest.config.ts that is not covered by PROJECTS_RUN_ELSEWHERE.
// Adding a new shared-layer package (a new node-mode project not in the
// exclusion set) grows this list with no ci.yml edit required — that is the
// property this function exists to guarantee.
//
// Throws rather than returning a degenerate answer, because the caller
// (run-shared-layer-tests.mjs) must never silently spawn vitest with an empty
// --project filter set, which runs EVERY project (including the three browser
// ones) in a job with no Playwright installed.
/**
 * @param {string} repoRoot
 * @returns {string[]} sorted project names
 */
export function deriveSharedLayerProjectNames(repoRoot) {
  const projects = readVitestProjects(repoRoot)
  const selected = projects.filter((p) => !p.isBrowser && !(p.configPath in PROJECTS_RUN_ELSEWHERE))

  const names = selected.map((p) => {
    if (!p.name) {
      throw new Error(
        `${p.configPath} would be selected for the derived shared-layer step but declares no test.name`,
      )
    }
    if (/-browser$/.test(p.name)) {
      // Belt-and-braces: the isBrowser detection above is itself a regex over
      // the config's `browser: { enabled: true }` block, which a differently
      // written browser config could miss. A name ending -browser is the
      // strongest available second signal that this project needs Playwright
      // and must never land in a job that doesn't have it.
      throw new Error(
        `${p.configPath} (project '${p.name}') was selected for the derived shared-layer step but its name looks browser-mode; refusing to run it in a job with no Playwright installed`,
      )
    }
    return p.name
  })

  if (names.length === 0) {
    throw new Error(
      'deriveSharedLayerProjectNames found no shared-layer projects to run — refusing to spawn vitest with an empty --project filter, which would run every project (including browser ones) with no filter at all',
    )
  }

  return names.sort()
}

/**
 * @param {string[]} names
 * @returns {string[]} argv for `pnpm <argv>`, e.g. ['exec', 'vitest', 'run', '--project=a']
 */
export function buildVitestArgv(names) {
  return ['exec', 'vitest', 'run', ...names.map((name) => `--project=${name}`)]
}

/**
 * @typedef {{ configPath: string, dir: string, name: string | undefined, isBrowser: boolean, include: string[], exclude: string[] }} VitestProjectGlobs
 */

// Per-project include/exclude patterns, for the coverage guard that asserts
// every test file in the tree belongs to at least one root project. The
// arrays are read textually (this package stays dependency-free), keeping
// only entries that look like test-path globs so an optimizeDeps.include or
// setupFiles list in the same config cannot pollute the result.
/**
 * @param {string} repoRoot
 * @returns {VitestProjectGlobs[]}
 */
export function readProjectTestGlobs(repoRoot) {
  const rootVitestConfig = readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8')
  const configPaths = [...rootVitestConfig.matchAll(/'([^']+\.config\.ts)'/g)].map(
    (match) => match[1],
  )
  return configPaths.map((configPath) => {
    const content = readFileSync(join(repoRoot, configPath), 'utf8')
    const arrays = (key) =>
      [...content.matchAll(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`, 'g'))]
        // Strip line comments BEFORE scanning quotes: an apostrophe in a
        // comment ("this project's own...") otherwise pairs with a real
        // entry's opening quote and silently swallows it.
        .map((match) => match[1].replace(/\/\/[^\n]*/g, ''))
        .flatMap((body) => [...body.matchAll(/'([^']+)'/g)].map((entry) => entry[1]))
        .filter((pattern) => pattern.includes('.test.') || pattern.includes('.bench.'))
    return {
      configPath,
      dir: configPath.slice(0, configPath.lastIndexOf('/')),
      name: content.match(/name:\s*'([^']+)'/)?.[1],
      isBrowser:
        /browser:\s*\{\s*\n?\s*enabled:\s*true/.test(content) ||
        /browser:\s*sharedBrowserTestConfig\(/.test(content),
      include: arrays('include'),
      exclude: arrays('exclude'),
    }
  })
}

// The one glob grammar the configs above actually use: literal path
// segments, `*` within a segment, and `**/` for zero or more directories.
// Deliberately NOT a general glob engine — the coverage guard's own unit
// tests pin each form, and an unsupported form fails visibly there rather
// than silently matching nothing.
/**
 * @param {string} pattern
 * @param {string} relPath path relative to the config's directory, '/'-separated
 * @returns {boolean}
 */
export function testGlobMatches(pattern, relPath) {
  const escapeRegExp = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const regex = pattern
    .split('**/')
    .map((part) => escapeRegExp(part).replace(/\*/g, '[^/]*'))
    .join('(?:[^/]+/)*')
  return new RegExp(`^${regex}$`).test(relPath)
}
