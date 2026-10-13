/**
 * The reference graph is WALKED in one place: canvas-render's
 * `walkReferences` (and its synchronous twin) is the only loop that calls
 * `referenceTargets` until it answers nothing new. This scan is the
 * executable half of that rule, beside `reference-seams-check.test.ts`,
 * which holds the seams the walk feeds.
 *
 * Why it exists: every keeper used to write the loop itself — the daemon's
 * render, the offline replica, the file list's row loader — and each copy
 * chose afresh which targets to skip and what a failed read meant. They
 * disagreed: two of them asked a keeper for a stored picture as though it
 * were a document, and spent the reference budget on it. What a keeper
 * decides is how ONE target is read and what a failed read records, and
 * the walker takes both as arguments.
 *
 * What it flags is a call to `referenceTargets` inside a loop statement of
 * the same function — the shape every copy had. A single call (what a
 * render's own seeds name, a prefetch key) is not a walk and passes.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { parseSource } from './ast-helpers.js'
import { REPO_ROOT, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const OWNER = 'packages/canvas-render/src/references/'

/**
 * Files allowed to walk by hand, each with the reason. Empty, and its length
 * pinned, so an addition is a decision in the diff.
 */
const LEDGER: Readonly<Record<string, string>> = {}

const isLoop = (node: ts.Node): boolean =>
  ts.isForStatement(node) ||
  ts.isForOfStatement(node) ||
  ts.isForInStatement(node) ||
  ts.isWhileStatement(node) ||
  ts.isDoStatement(node)

const isTargetsCall = (node: ts.Node): node is ts.CallExpression => {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  if (ts.isIdentifier(callee)) return callee.text === 'referenceTargets'
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'referenceTargets'
}

/** Every `referenceTargets` call in `source`, and whether a loop of its own function encloses it. */
function targetsCalls(fileName: string, source: string): { readonly inLoop: boolean }[] {
  const calls: { inLoop: boolean }[] = []
  const visit = (node: ts.Node): void => {
    if (isTargetsCall(node)) {
      let inLoop = false
      for (let up = node.parent; up !== undefined && !ts.isFunctionLike(up); up = up.parent) {
        if (isLoop(up)) {
          inLoop = true
          break
        }
      }
      calls.push({ inLoop })
    }
    ts.forEachChild(node, visit)
  }
  visit(parseSource(fileName, source))
  return calls
}

const walks = (fileName: string, source: string): number =>
  targetsCalls(fileName, source).filter((call) => call.inLoop).length

const FIXTURES: readonly { readonly source: string; readonly walks: boolean }[] = [
  {
    source:
      'for (;;) { const w = referenceTargets({ ...s, loaded: g }).filter((t) => !g.has(t)); if (!w.length) break }',
    walks: true,
  },
  { source: 'while (true) { if (render.referenceTargets(s).length === 0) break }', walks: true },
  { source: 'do { next = referenceTargets(s) } while (next.length)', walks: true },
  { source: 'for (const s of seeds) out.push(...referenceTargets(s))', walks: true },
  { source: 'const key = referenceTargets({ bodies: [text] }).join("\\n")', walks: false },
  { source: 'for (const t of referenceTargets(s)) load(t)', walks: true },
  // A callback is its own function: the loop around it is not the walk.
  { source: 'for (const d of docs) d.on(() => referenceTargets(d.seeds))', walks: false },
  { source: 'for (;;) { const w = otherTargets(s); if (!w.length) break }', walks: false },
  { source: '// for (;;) referenceTargets(s) — prose', walks: false },
]

const production = SCAN_ROOTS.flatMap((root) => walkSourceFiles(join(REPO_ROOT, root)))
  .filter((path) => !isTestPath(path))
  .map((path) => ({ path, rel: relative(REPO_ROOT, path).split(sep).join('/') }))
  .filter(({ rel }) => !rel.startsWith(OWNER))

describe('the reference graph is walked in one place', () => {
  it('recognises a hand-written walk and passes a single call', () => {
    for (const fixture of FIXTURES) {
      expect(walks('fixture.ts', fixture.source) > 0, fixture.source).toBe(fixture.walks)
    }
  })

  it('reaches the callers it judges', () => {
    // A scan that finds no `referenceTargets` call outside its owner agrees
    // with every rule; the count of callers it did read is what keeps it honest.
    const callers = production.filter(
      ({ path, rel }) => targetsCalls(rel, readFileSync(path, 'utf8')).length > 0,
    )
    expect(callers.length).toBeGreaterThanOrEqual(4)
  })

  it('no keeper walks the reference graph by hand', () => {
    const hits = production
      .filter(({ rel }) => LEDGER[rel] === undefined)
      .filter(({ path, rel }) => walks(rel, readFileSync(path, 'utf8')) > 0)
      .map(({ rel }) => rel)
    expect(
      hits,
      'a loop over `referenceTargets` outside canvas-render/src/references — call `walkReferences` (or `walkReferencesSync`) with how one target is read instead',
    ).toEqual([])
  })

  it('every ledger entry still walks by hand', () => {
    const stale = Object.keys(LEDGER).filter((rel) => {
      try {
        return walks(rel, readFileSync(join(REPO_ROOT, rel), 'utf8')) === 0
      } catch {
        return true
      }
    })
    expect(stale, 'an entry that outlives its walk is how a ledger stops being read').toEqual([])
  })

  it('holds the ledger at its declared ceiling', () => {
    expect(Object.keys(LEDGER)).toHaveLength(0)
  })
})
