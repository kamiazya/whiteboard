// `// @vitest-environment node` is a CLAIM ABOUT A FILE'S BODY: this test
// touches no DOM, so it does not need jsdom built for it (measured: jsdom
// creation was 38% of web-jsdom's tracked time, and moving 141 DOM-free files
// off it took the project from 219s to 188s).
//
// A claim about a body is exactly what a merge can invalidate without a
// conflict. Measured: `use-keyboard-avoidance.test.ts` was annotated when it
// was DOM-free; main later gave it `document.createElement` in #1384; the two
// sides touched different lines, git merged them cleanly, and CI failed with
// three `ReferenceError: document is not defined`. Neither side was wrong on
// its own — only their combination, which is the one thing no reviewer of
// either change was looking at.
//
// So the annotation is checked against the file rather than trusted. This
// reuses the SAME AST scan that enforces the shared layer's DOM ban
// (scanner.ts), because the textual version of this check is worthless here:
// `document` is this repo's own domain noun, and a word-boundary regex
// reports 47 of the 141 files, nearly all of them variables and types named
// `document`.

import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { scanSourceForBoundaryViolations } from './scanner.js'
import { listTestFiles } from './test-scan-dirs.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../..')

const ANNOTATION = '// @vitest-environment node'

interface Annotated {
  readonly path: string
  readonly source: string
}

function annotatedFiles(): Annotated[] {
  const found: Annotated[] = []
  for (const file of listTestFiles(join(ROOT, 'apps/web/src'))) {
    const source = readFileSync(file, 'utf-8')
    // The docblock only takes effect at the top of the file, so a mention
    // further down is prose about the technique, not a claim.
    if (!source.startsWith(ANNOTATION)) continue
    found.push({ path: relative(ROOT, file), source })
  }
  return found
}

const annotated = annotatedFiles()

describe('a node-environment annotation matches the file it sits on', () => {
  it('found the annotated set', () => {
    // A scan that silently matches nothing passes every assertion below.
    expect(annotated.length, 'no @vitest-environment node files found').toBeGreaterThan(50)
  })

  // scanner.ts's DOM list is the SHARED LAYER's ban, which is a different
  // question: it bans `navigator` because a Worker and Node must behave
  // alike, while Node has had a real `navigator` global since 21 and two
  // annotated files legitimately use it. What matters here is only "would
  // this identifier be missing without jsdom", so the set is PROBED against
  // the runtime actually executing rather than inferred from a list that
  // goes stale with each Node release.
  const missingWithoutJsdom = (name: string): boolean =>
    !(name in globalThis) || (globalThis as Record<string, unknown>)[name] === undefined

  it('probes a set that is neither empty nor everything', () => {
    // Both degenerate outcomes pass the assertion below while checking
    // nothing: an empty set finds no offender, a full set is the old scan.
    expect(missingWithoutJsdom('document'), 'document must count as jsdom-only').toBe(true)
    expect(missingWithoutJsdom('navigator'), 'Node has its own navigator').toBe(false)
  })

  it('no annotated file references a global that only jsdom provides', () => {
    const offenders = annotated
      .map((file) => ({
        path: file.path,
        globals: scanSourceForBoundaryViolations(file.path, file.source)
          .filter((v) => v.kind === 'dom-global' && missingWithoutJsdom(v.name))
          .map((v) => `${v.name}:${v.line}`),
      }))
      .filter((entry) => entry.globals.length > 0)
      .map((entry) => `${entry.path} (${entry.globals.join(', ')})`)

    expect(
      offenders,
      'these files declare a node environment and use a global only jsdom provides — either drop the annotation so jsdom is built for them, or remove the DOM usage',
    ).toEqual([])
  })
})
