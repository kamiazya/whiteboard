/**
 * An `await import()` INSIDE a test body charges that module graph's
 * transform-and-load to the per-test timeout — ample on an idle machine,
 * and the first thing to blow once the full suite runs every project in
 * parallel (aggregate import time there is measured in minutes). The
 * failure names the test, not the import, and reads as a mysterious
 * load-dependent flake. Hoisted to a static top-level import, the cost
 * lands in the collection phase no per-test timeout bounds.
 *
 * A dynamic import is legitimate when the file mocks what it imports
 * (`vi.mock`/`vi.doMock`/`vi.resetModules` make evaluation order the point)
 * or when the specifier is computed (`pathToFileURL(...)` — the release
 * suites loading .mjs scripts by path). Those are recognised structurally.
 * Anything else deliberate carries a `lazy-import: <reason>` comment on the
 * line above, the same shape as an EXEMPT_FILES entry: visible, reasoned,
 * and greppable.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

const SCAN_DIRS = [
  'apps/web/src',
  'packages/model/src',
  'packages/codec/src',
  'packages/canvas-render/src',
  'packages/ports/src',
  'packages/loro-adapter/src',
  'packages/server-core/src',
  'packages/canvas-viewer/src',
  'packages/mcp-server/src',
  'tools/arch-lint/src',
] as const

/** Files whose `await import(` lives inside STRING FIXTURES, not code. */
const EXEMPT_FILES: Record<string, string> = {
  'tools/arch-lint/src/scanner.test.ts': 'the dynamic import is a scanner fixture string',
  'tools/arch-lint/src/cycle-check.test.ts': 'the dynamic import is a cycle-check fixture string',
  'tools/arch-lint/src/test-lazy-import-check.test.ts': 'this guard names the pattern it hunts',
}

/** Module-mock machinery that makes evaluation order the test's point. */
const MOCK_MACHINERY = /vi\.(mock|doMock|resetModules|unmock)\(/

/** An INDENTED await import of a LITERAL specifier — the flake shape. */
const IN_BODY_LITERAL_IMPORT = /^\s+.*await import\(\s*(?:\/\*.*\*\/\s*)?['"`]/

const MARKER = 'lazy-import:'

function listTestFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listTestFiles(full))
      continue
    }
    if (/\.test\.(ts|tsx)$/.test(entry.name)) files.push(full)
  }
  return files
}

function offendingLines(source: string): Array<{ line: number; text: string }> {
  if (MOCK_MACHINERY.test(source)) return []
  const lines = source.split('\n')
  const hits: Array<{ line: number; text: string }> = []
  for (const [index, line] of lines.entries()) {
    if (!IN_BODY_LITERAL_IMPORT.test(line)) continue
    if (line.includes(MARKER)) continue
    const preceding = lines.slice(Math.max(0, index - 4), index).join('\n')
    if (preceding.includes(MARKER)) continue
    hits.push({ line: index + 1, text: line.trim() })
  }
  return hits
}

describe('in-body await import in test files', () => {
  it('scans a real population', () => {
    const all = SCAN_DIRS.flatMap((dir) => listTestFiles(join(REPO_ROOT, dir)))
    expect(all.length).toBeGreaterThan(300)
  })

  it('detects the shape, and honors mocks, markers, and computed paths (self-test)', () => {
    expect(
      offendingLines(`it('x', async () => {\n  const { y } = await import('./y.js')\n})`),
    ).toHaveLength(1)
    expect(
      offendingLines(
        `vi.mock('./y.js')\nit('x', async () => {\n  const { y } = await import('./y.js')\n})`,
      ),
    ).toHaveLength(0)
    expect(
      offendingLines(
        `it('x', async () => {\n  // lazy-import: identity is the subject\n  const { y } = await import('./y.js')\n})`,
      ),
    ).toHaveLength(0)
    expect(
      offendingLines(`it('x', async () => {\n  const m = await import(pathToFileURL(p).href)\n})`),
    ).toHaveLength(0)
  })

  it('every in-body literal await import is mocked, marked, or hoisted', () => {
    const offenders: string[] = []
    for (const dir of SCAN_DIRS) {
      for (const file of listTestFiles(join(REPO_ROOT, dir))) {
        const relativePath = relative(REPO_ROOT, file).split(sep).join('/')
        if (relativePath in EXEMPT_FILES) continue
        for (const hit of offendingLines(readFileSync(file, 'utf-8'))) {
          offenders.push(`${relativePath}:${hit.line}: ${hit.text}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('EXEMPT_FILES entries still exist and still contain the pattern they excuse', () => {
    for (const relativePath of Object.keys(EXEMPT_FILES)) {
      if (relativePath.endsWith('test-lazy-import-check.test.ts')) continue
      const source = readFileSync(join(REPO_ROOT, relativePath), 'utf-8')
      expect(source, relativePath).toMatch(/await import\(/)
    }
  })
})
