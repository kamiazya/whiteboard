/**
 * "This box lies inside that one" is `frameHolds` in the model, and nothing
 * else writes the four comparisons out.
 *
 * It was spelled out at seven sites — each a copy of the edge-inclusive rule
 * whose members would drift the moment one changed (a frame's members in the
 * OCIF export, in a fragment, in an agent's region edit, in a drag, against
 * the editor's visible area). The cost of drift is concrete: the same frame
 * would carry different members on the screen and in the file it exports.
 *
 * The scan reads a conjunction's comparisons, not a name, because every copy
 * used its own box variables. Two sites keep their own on purpose and are
 * ledgered: a rect type with `w`/`h` that the model's `{width, height}`
 * function cannot take without an adapter at each call, and the render-quality
 * metrics, which are independent of the code they judge by design.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { containmentChains } from './box-containment-one-place.js'
import { REPO_ROOT, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const OWNER = 'packages/model/src/spatial.ts'

/**
 * Files that spell the rule themselves: how many chains each may hold, and the
 * reason. Counted, not merely listed, so a second copy appended to a ledgered
 * file fails like a new file would.
 */
const LEDGER: Readonly<Record<string, { readonly chains: number; readonly reason: string }>> = {
  'packages/canvas-render/src/quality/rect.ts': {
    chains: 1,
    reason:
      'the quality metrics are independent of the layout code they judge, so they do not call into the model',
  },
  'packages/canvas-render/src/layout/edges/edge-rules.ts': {
    chains: 1,
    reason:
      "the edge router's own `{x, y, w, h}` Rect; `frameHolds` takes `{width, height}` and every call here would need an adapter",
  },
}

const CONTAINMENT = `a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height`

const FIXTURES: readonly { readonly source: string; readonly spells: boolean }[] = [
  { source: `const f = (a, b) => ${CONTAINMENT}`, spells: true },
  {
    source:
      'if (!locked(n.id) && n.x >= s.x && n.y >= s.y && (n.x + n.w) <= (s.x + s.w) && n.y + n.h <= s.y + s.h) add(n)',
    spells: true,
  },
  {
    source:
      'inner.x >= o.x && inner.y >= o.y && o.x + o.w >= inner.x + inner.w && o.y + o.h >= inner.y + inner.h',
    spells: true,
  },
  // The De Morgan form says the box is NOT inside, and the strict form is still the rule.
  {
    source:
      'if (a.x < b.x || a.y < b.y || a.x + a.width > b.x + b.width || a.y + a.height > b.y + b.height) skip()',
    spells: true,
  },
  {
    source:
      'a.x > b.x && a.y > b.y && a.x + a.width < b.x + b.width && a.y + a.height < b.y + b.height',
    spells: true,
  },
  {
    source:
      '!(a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height)',
    spells: true,
  },
  {
    source:
      'locked(a) && (a.x < b.x || a.y < b.y || a.x + a.width > b.x + b.width || a.y + a.height > b.y + b.height)',
    spells: true,
  },
  { source: 'a.x < b.x || a.y < b.y', spells: false },
  // Separation is a disjunction over near-against-far, which is not the rule.
  {
    source:
      'a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y',
    spells: false,
  },
  // Overlap and clamping share parts of the rule, and are not it.
  {
    source:
      'a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y',
    spells: false,
  },
  {
    source: 'p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height',
    spells: false,
  },
  { source: 'a.x >= b.x && a.y >= b.y', spells: false },
  { source: `// ${CONTAINMENT}\nconst x = 1`, spells: false },
  { source: 'frameHolds(frame, node)', spells: false },
]

const files: string[] = []
for (const root of SCAN_ROOTS) walkSourceFiles(join(REPO_ROOT, root), files)
const production = files
  .filter((path) => !isTestPath(path))
  .map((path) => ({ path, rel: relative(REPO_ROOT, path).split(sep).join('/') }))

const chainsIn = (path: string): number =>
  containmentChains(path, readFileSync(path, 'utf8')).length

describe('box containment is written in one place', () => {
  it('recognises the rule in every spelling, and not a neighbouring one', () => {
    for (const { source, spells } of FIXTURES) {
      expect(containmentChains('fixture.ts', source).length > 0, source).toBe(spells)
    }
  })

  it('scans a tree worth scanning, and finds the model spelling it', () => {
    // An empty scan agrees with every rule; finding the owner is what keeps it honest.
    expect(production.length).toBeGreaterThan(1000)
    expect(chainsIn(join(REPO_ROOT, OWNER))).toBeGreaterThan(0)
  })

  it('has no other spelling than the owner and the ledgered files', () => {
    const spellings = production
      .filter(({ path }) => chainsIn(path) > 0)
      .map(({ rel }) => rel)
      .filter((rel) => rel !== OWNER && !(rel in LEDGER))
    expect(
      spellings,
      'ask `frameHolds(frame, node)` or `membersOf(nodes, frame)` from @kamiazya/whiteboard-model instead of writing the four comparisons',
    ).toEqual([])
  })

  it('holds every ledgered file to exactly the chains it claims', () => {
    for (const [rel, { chains }] of Object.entries(LEDGER)) {
      const entry = production.find((file) => file.rel === rel)
      expect(entry, `${rel} is not a scanned production file`).toBeDefined()
      expect(chainsIn(entry?.path ?? ''), `${rel}: chains of containment, as ledgered`).toBe(chains)
    }
  })

  it('counts a chain once however it is wrapped, and a second copy as a second', () => {
    const copy = `a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height`
    expect(containmentChains('f.ts', `const a = ${copy}`)).toHaveLength(1)
    expect(containmentChains('f.ts', `const a = (${copy}) && !locked`)).toHaveLength(1)
    expect(containmentChains('f.ts', `const a = ((${copy}) as boolean) && !locked`)).toHaveLength(1)
    expect(containmentChains('f.ts', `const a = ${copy}\nconst b = ${copy}`)).toHaveLength(2)
  })

  it('gives every ledger entry a reason in a sentence', () => {
    for (const [rel, { reason }] of Object.entries(LEDGER)) {
      expect(reason.split(/\s+/).length, `${rel}'s reason is too short`).toBeGreaterThan(8)
    }
  })
})
