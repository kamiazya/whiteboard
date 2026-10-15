/**
 * "All four of this box's coordinates are finite" is `isFiniteRect` in the
 * model, and nothing else writes the four `Number.isFinite` calls out.
 *
 * It is the guard that keeps snap, align, tidy and the minimap from turning a
 * NaN box into a NaN transform, and it was spelled out at five sites. A
 * change to what counts as usable — rejecting a negative size, say — would
 * have had to be made five times, and a sixth caller had no one place to find.
 *
 * Read from the syntax tree, not a name, because every copy named its box
 * differently. The scene's `{x, y, w, h}` box is canvas-render's
 * `isFiniteBox` and is a different shape, so it is not matched here.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { finiteRectChecks } from './finite-rect-one-place.js'
import { REPO_ROOT, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const OWNER = 'packages/model/src/bounds.ts'

const FOUR =
  'Number.isFinite(box.x) && Number.isFinite(box.y) && Number.isFinite(box.width) && Number.isFinite(box.height)'

const FIXTURES: readonly { readonly source: string; readonly spells: boolean }[] = [
  { source: `const f = (box) => ${FOUR}`, spells: true },
  { source: `boxes.filter((n) => (${FOUR.replaceAll('box.', 'n.')}))`, spells: true },
  // Extra conjuncts beside the four do not hide the rule.
  { source: `const ok = ${FOUR} && box.width > 0`, spells: true },
  {
    source: 'const ok = isFinite(r.x) && isFinite(r.y) && isFinite(r.width) && isFinite(r.height)',
    spells: true,
  },
  { source: '[next.x, next.y, next.width, next.height].every(Number.isFinite)', spells: true },
  // The scene's `{x, y, w, h}` box is another shape with its own predicate.
  {
    source:
      'Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h)',
    spells: false,
  },
  // Four fields across two receivers is not one rect.
  {
    source:
      'Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(b.width) && Number.isFinite(b.height)',
    spells: false,
  },
  { source: 'Number.isFinite(p.x) && Number.isFinite(p.y)', spells: false },
  { source: '[p.x, p.y].every(Number.isFinite)', spells: false },
  { source: `// ${FOUR}\nconst x = 1`, spells: false },
  { source: 'isFiniteRect(box)', spells: false },
]

const files: string[] = []
for (const root of SCAN_ROOTS) walkSourceFiles(join(REPO_ROOT, root), files)
const production = files
  .filter((path) => !isTestPath(path))
  .map((path) => ({ path, rel: relative(REPO_ROOT, path).split(sep).join('/') }))

const checksIn = (path: string): number => finiteRectChecks(path, readFileSync(path, 'utf8')).length

describe('the finite-rect check is written in one place', () => {
  it('recognises the rule in every spelling, and not a neighbouring one', () => {
    for (const { source, spells } of FIXTURES) {
      expect(finiteRectChecks('fixture.ts', source).length > 0, source).toBe(spells)
    }
  })

  it('counts a chain once however it is wrapped, and a second copy as a second', () => {
    expect(finiteRectChecks('f.ts', `const a = (${FOUR}) && ready`)).toHaveLength(1)
    expect(finiteRectChecks('f.ts', `const a = ((${FOUR}) as boolean)`)).toHaveLength(1)
    expect(finiteRectChecks('f.ts', `const a = ${FOUR}\nconst b = ${FOUR}`)).toHaveLength(2)
  })

  it('scans a tree worth scanning, and finds the model spelling it', () => {
    // An empty scan agrees with every rule; finding the owner is what keeps it honest.
    expect(production.length).toBeGreaterThan(1000)
    expect(checksIn(join(REPO_ROOT, OWNER))).toBe(1)
  })

  it('has no other spelling than the owner', () => {
    const spellings = production
      .filter(({ path }) => checksIn(path) > 0)
      .map(({ rel }) => rel)
      .filter((rel) => rel !== OWNER)
    expect(
      spellings,
      'ask `isFiniteRect(rect)` from @kamiazya/whiteboard-model instead of writing the four `Number.isFinite` calls',
    ).toEqual([])
  })
})
