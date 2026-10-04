/**
 * "Where a comment on a box pins" is `commentCornerOf` in the model, and
 * nothing else writes the corner out.
 *
 * It was spelled at seven sites — the thread projection, the renderer's pin,
 * a node-set region's pin, the editor's two compose entries and the agent
 * tool's default anchor — and a copy that drifted opens a draft in one place
 * and settles it in another. The scan reads an object literal's three member
 * reads (`b.x + b.width`, `b.y`, both off the same base), not a name, because
 * every copy called its box something different.
 *
 * A literal that is a top-right corner for a reason other than a comment pin
 * is ledgered with that reason, so the question "is this the comment's
 * corner?" is answered once per site rather than waved through.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'
import { topRightCornerLiterals } from './top-right-corner-one-place.js'

const OWNER = 'packages/model/src/annotation.ts'

/** Files that spell a top-right corner for a reason that is not a comment pin. */
const LEDGER: Readonly<Record<string, string>> = {}

const FIXTURES: readonly { readonly source: string; readonly spells: boolean }[] = [
  { source: 'const p = { x: node.x + node.width, y: node.y }', spells: true },
  { source: 'const p = { y: node.y, x: node.x + node.width }', spells: true },
  { source: 'const p = { x: region.rect.x + region.rect.width, y: region.rect.y }', spells: true },
  {
    source: 'const p = { x: Math.round(t.x + t.width), y: Math.round(t.y) }',
    spells: true,
  },
  { source: 'const p = { x: (n.x + n.width), y: n.y, targetNodeId: n.id }', spells: true },
  // The other corners, other boxes and other members are not it.
  { source: 'const p = { x: node.x, y: node.y }', spells: false },
  { source: 'const p = { x: node.x + node.width, y: node.y + node.height }', spells: false },
  { source: 'const p = { x: a.x + b.width, y: a.y }', spells: false },
  { source: 'const p = { x: a.x + a.width, y: b.y }', spells: false },
  { source: 'const p = { x: a.x + a.height, y: a.y }', spells: false },
  { source: 'const p = { ...commentCornerOf(node), targetNodeId: node.id }', spells: false },
  { source: `// const p = { x: node.x + node.width, y: node.y }\nconst x = 1`, spells: false },
]

const files: string[] = []
for (const root of SCAN_ROOTS) walkSourceFiles(join(REPO_ROOT, root), files)
const production = files
  .filter((path) => !isTestPath(path))
  .map((path) => ({ path, rel: relative(REPO_ROOT, path).split(sep).join('/') }))

const spelling = (path: string): boolean =>
  topRightCornerLiterals(path, readFileSync(path, 'utf8')).length > 0

describe('a comment on a box pins at its top-right corner, written in one place', () => {
  it('recognises the corner in every spelling, and not a neighbouring one', () => {
    for (const { source, spells } of FIXTURES) {
      expect(topRightCornerLiterals('fixture.ts', source).length > 0, source).toBe(spells)
    }
  })

  it('reports the 1-based line each corner literal starts on', () => {
    const source = [
      'const a = { x: n.x + n.width, y: n.y }',
      'const b = 1',
      'const c = {',
      '  x: m.x + m.width,',
      '  y: m.y,',
      '}',
    ].join('\n')
    expect(topRightCornerLiterals('fixture.ts', source)).toEqual([1, 3])
  })

  it('scans a tree worth scanning, and finds the model spelling it', () => {
    // An empty scan agrees with every rule; finding the owner is what keeps it honest.
    expect(production.length).toBeGreaterThan(1000)
    expect(spelling(join(REPO_ROOT, OWNER))).toBe(true)
  })

  it('has no other spelling than the owner and the ledgered files', () => {
    const spellings = production
      .filter(({ path }) => spelling(path))
      .map(({ rel }) => rel)
      .filter((rel) => rel !== OWNER && !(rel in LEDGER))
    expect(
      spellings,
      'ask `commentCornerOf(box)` from @kamiazya/whiteboard-model instead of writing `{ x: box.x + box.width, y: box.y }`',
    ).toEqual([])
  })

  it('ledgers only files that still spell it', () => {
    for (const rel of Object.keys(LEDGER)) {
      const entry = production.find((file) => file.rel === rel)
      expect(entry, `${rel} is not a scanned production file`).toBeDefined()
      expect(spelling(entry?.path ?? ''), `${rel} no longer spells the corner`).toBe(true)
    }
  })
})
