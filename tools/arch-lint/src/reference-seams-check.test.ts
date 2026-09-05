/**
 * References resolve in ONE place: canvas-render's `referenceSeams` is the
 * only producer of the four seams a layout reads to draw what a document
 * points at (`resolveAlias`, `resolveTitle`, `resolveEmbed`,
 * `resolveReference`). This scan is the executable half of that rule.
 *
 * Why it exists: each composition root used to write those seams by hand,
 * and the layout — total by design — drew placeholders for whichever one a
 * root forgot rather than failing. The web preview drew a canvas behind
 * `![[path]]` while `wb_scene_render` refused the document; the daemon
 * resolved file references to markdown bodies while the browser editor
 * resolved them to canvases too. Nothing was red, because a missing seam is
 * a legitimate state for a render that resolves nothing on purpose. So the
 * rule cannot be "every surface wires every seam"; it is "no surface
 * DEFINES a seam", and that a scan can hold.
 *
 * A root may still name a seam to pass it along (`resolveReference:
 * options.resolveReference`), wrap the bundle's seam with plain-data chrome
 * (`overlayReferences`), or hand `referenceSeams` its own alias table as an
 * INPUT. What it may not do is write the function body — `resolveEmbed:
 * (id) => …`, `const resolveReference = (ref) => …`, a method shorthand —
 * because that body is where "what does this reference draw as" gets
 * decided a second time.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

/** Every composition root and UI package that lays documents out. */
const SCAN_DIRS = [
  'apps/web/src',
  'packages/canvas-viewer/src',
  'packages/server-core/src',
  'packages/mcp-server/src',
]

const SEAM = '(?:resolveAlias|resolveTitle|resolveEmbed|resolveReference)'

/**
 * A seam DEFINED rather than passed: an object key or a binding whose
 * value is written as an arrow function or a `function`, or a method
 * shorthand. `x: someCall(...)` and `x: other.x` are not definitions and
 * do not match; neither does a page's `const resolveAlias = useMemo(...)`,
 * which is an input to the bundle, not a seam of its own.
 */
const DEFINITION_PATTERNS: readonly { readonly pattern: RegExp; readonly shape: string }[] = [
  {
    pattern: new RegExp(
      `\\b${SEAM}\\s*[:=]\\s*(?:async\\s*)?(?:\\([^)]*\\)\\s*(?::[^=]*)?=>|[A-Za-z_$][\\w$]*\\s*=>|function\\b)`,
    ),
    shape: 'an arrow function or `function` assigned to a seam name',
  },
  {
    pattern: new RegExp(`^\\s*(?:async\\s+)?${SEAM}\\s*\\([^)]*\\)\\s*(?::[^{]*)?\\{`, 'm'),
    shape: 'a method-shorthand seam',
  },
]

/**
 * Files allowed to define one, each with the reason. Empty today, and the
 * length is pinned so an addition is a decision in the diff — the same
 * both-sides discipline every arch-lint allowlist keeps.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
}

function isTest(path: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(path) || path.split(sep).includes('test-utils')
}

/** Comments stripped, so prose describing a seam is not read as defining one. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
}

const files: string[] = []
for (const dir of SCAN_DIRS) walk(join(REPO_ROOT, dir), files)
const production = files.filter((path) => !isTest(path))

describe('references resolve in one place', () => {
  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(production.length).toBeGreaterThan(200)
  })

  it('no composition root or UI package defines a reference seam by hand', () => {
    const hits: string[] = []
    for (const path of production) {
      const rel = relative(REPO_ROOT, path).split(sep).join('/')
      if (ALLOWLIST[rel] !== undefined) continue
      const source = stripComments(readFileSync(path, 'utf8'))
      for (const { pattern, shape } of DEFINITION_PATTERNS) {
        const match = pattern.exec(source)
        if (match !== null) hits.push(`${rel}: ${shape} — \`${match[0].trim().slice(0, 80)}\``)
      }
    }
    expect(
      hits,
      'a reference seam is defined outside canvas-render/src/references — build it with `referenceSeams` over a loaded graph instead, so every surface answers the same way',
    ).toEqual([])
  })

  it('every allowlist entry still names a file that defines one', () => {
    const stale = Object.keys(ALLOWLIST).filter((rel) => {
      const path = join(REPO_ROOT, rel)
      let source: string
      try {
        source = stripComments(readFileSync(path, 'utf8'))
      } catch {
        return true
      }
      return !DEFINITION_PATTERNS.some(({ pattern }) => pattern.test(source))
    })
    expect(
      stale,
      'an entry that outlives its definition is how an allowlist stops being read',
    ).toEqual([])
  })

  it('holds the allowlist at its declared ceiling', () => {
    expect(Object.keys(ALLOWLIST)).toHaveLength(0)
  })
})
