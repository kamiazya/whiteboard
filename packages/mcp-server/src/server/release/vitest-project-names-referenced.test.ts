// A vitest project name written into prose or a script is a string nothing
// resolves. vitest only errors when a `--project` filter set is EMPTY, so a
// name that matches nothing beside one that does is silent (dev-flow.md
// measured it), and in a document it is just text — `mcp-jsdom` and
// `mcp-browser` outlived the projects they named, in the PR template and in
// the agents a session loads before it writes its first test.
//
// The inventory is the one parser every other guard reads
// (`tools/checks/src/vitest-projects.mjs`), not a second hand-written list.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { trackedFiles } from '../../shared/test-utils/tracked-files.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..')

const { readVitestProjects } = (await import(
  pathToFileURL(join(ROOT, 'tools/checks/src/vitest-projects.mjs')).href
)) as { readVitestProjects: (repoRoot: string) => { name: string | undefined }[] }

// `canvas-render-node (bench)` is addressed as `canvas-render-node` in prose.
const names = new Set(
  readVitestProjects(ROOT)
    .map((project) => project.name?.replace(/\s*\(.*\)$/, ''))
    .filter((name): name is string => name !== undefined),
)

// Only a token shaped like a project name is judged: a package prefix some
// real project uses, then the environment. `in-browser` is not one.
const prefixes = [...names].map((name) => name.replace(/-(node|jsdom|browser)\b.*$/, ''))
const PROJECT_SHAPED = new RegExp(
  `\\b(?:${[...new Set(prefixes)].join('|')})-(?:node|jsdom|browser)\\b`,
  'g',
)
// wrangler has a `--project-name`, and prose says "--project pins" — only a
// vitest invocation's flag is judged.
const PROJECT_FLAG = /--project[ =]([a-z][\w-]*\*?)/g
const VITEST_INVOCATION = /vitest|pnpm test/

// Prose that must keep the retired spelling to say it is retired.
const MAY_NAME_RETIRED: ReadonlySet<string> = new Set([])

const scanned = [...trackedFiles(ROOT, '.claude', '.github'), ...trackedFiles(ROOT, '*.md')]
  .filter((path) => /\.(md|mjs|ya?ml)$/.test(path))
  .filter((path, index, all) => all.indexOf(path) === index)

describe('vitest project names written outside vitest.config.ts exist', () => {
  it('reads the real inventory and reaches the files that name projects', () => {
    expect(names.size).toBeGreaterThan(20)
    expect(names).toContain('mcp-node')
    expect(scanned).toContain('.github/PULL_REQUEST_TEMPLATE.md')
    expect(scanned).toContain('.claude/agents/developer.md')
    expect(scanned.length).toBeGreaterThan(250)
  })

  it('every project-shaped token and every --project value is a real project', () => {
    const unknown: string[] = []
    for (const path of scanned) {
      if (MAY_NAME_RETIRED.has(path)) continue
      const text = readFileSync(join(ROOT, path), 'utf-8')
      const tokens = [
        ...(text.match(PROJECT_SHAPED) ?? []),
        ...text
          .split('\n')
          .filter((line) => VITEST_INVOCATION.test(line))
          .flatMap((line) => [...line.matchAll(PROJECT_FLAG)].map((m) => m[1] ?? '')),
      ]
      for (const token of new Set(tokens)) {
        if (!names.has(token)) unknown.push(`${path}: ${token}`)
      }
    }
    expect(
      unknown,
      'name a project from vitest.config.ts, or point at test-layer-selection',
    ).toEqual([])
  })
})
