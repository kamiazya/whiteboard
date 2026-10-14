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
 * What it flags is a loop around a call that reads targets, and a recursion
 * that reads them — see `scan`. A single call (what a render's own seeds
 * name, a prefetch key) is not a walk and passes.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { importBindingsOf, parseSource } from './ast-helpers.js'
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

/**
 * The local names `referenceTargets` answers to: its own, unless an import
 * gives that name to something else, plus whatever an import renames it to.
 */
function targetsNames(file: ts.SourceFile): ReadonlySet<string> {
  const bindings = importBindingsOf(file)
  const aliases = new Set(
    bindings.filter((b) => b.imported === 'referenceTargets').map((b) => b.local),
  )
  const shadowed = bindings.some(
    (b) => b.local === 'referenceTargets' && b.imported !== 'referenceTargets',
  )
  if (!shadowed) aliases.add('referenceTargets')
  return aliases
}

/** The same-file name a call reaches: `f(…)` or `this.f(…)`. */
const calleeName = (call: ts.CallExpression): string | undefined => {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword)
    return callee.name.text
  return undefined
}

/** Named functions of the file — declarations, `const f = () => …`, methods — by name. */
function namedFunctions(file: ts.SourceFile): ReadonlyMap<string, readonly ts.Node[]> {
  const byName = new Map<string, ts.Node[]>()
  const add = (name: ts.Node | undefined, fn: ts.Node): void => {
    if (name === undefined || !ts.isIdentifier(name)) return
    byName.set(name.text, [...(byName.get(name.text) ?? []), fn])
  }
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) add(node.name, node)
    else if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    )
      add(node.name, node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return byName
}

const callsIn = (node: ts.Node): ts.CallExpression[] => {
  const calls: ts.CallExpression[] = []
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child)) calls.push(child)
    ts.forEachChild(child, visit)
  }
  ts.forEachChild(node, visit)
  return calls
}

const loopEncloses = (call: ts.Node): boolean => {
  for (let up = call.parent; up !== undefined && !ts.isFunctionLike(up); up = up.parent) {
    if (isLoop(up)) return true
  }
  return false
}

type CallGraph = ReadonlyMap<string, ReadonlySet<string>>

/** Which named functions of the file each named function calls. */
const callGraph = (functions: ReadonlyMap<string, readonly ts.Node[]>): CallGraph =>
  new Map(
    [...functions].map(([name, nodes]) => [
      name,
      new Set(
        nodes
          .flatMap(callsIn)
          .map(calleeName)
          .filter((callee): callee is string => callee !== undefined && functions.has(callee)),
      ),
    ]),
  )

/** The named functions that reach a `referenceTargets` call, directly or through each other. */
function readers(
  functions: ReadonlyMap<string, readonly ts.Node[]>,
  callees: CallGraph,
  isTargetsCall: (call: ts.CallExpression) => boolean,
): ReadonlySet<string> {
  const reads = new Set(
    [...functions]
      .filter(([, nodes]) => nodes.flatMap(callsIn).some(isTargetsCall))
      .map(([name]) => name),
  )
  for (let grew = true; grew; ) {
    grew = false
    for (const [name, out] of callees) {
      if (!reads.has(name) && [...out].some((callee) => reads.has(callee))) {
        reads.add(name)
        grew = true
      }
    }
  }
  return reads
}

function reachesItself(name: string, callees: CallGraph): boolean {
  const seen = new Set<string>()
  const pending = [...(callees.get(name) ?? [])]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next === name) return true
    if (seen.has(next)) continue
    seen.add(next)
    pending.push(...(callees.get(next) ?? []))
  }
  return false
}

/**
 * How many `referenceTargets` calls `source` makes, and how many walks it
 * holds. A walk is a loop of a function around a call that reads targets —
 * `referenceTargets` itself, or a same-file function that reaches it, which
 * is the owner's own shape (a `frontier` helper and a loop over it) — or a
 * function that reaches `referenceTargets` and reaches itself again, since
 * recursion is a loop no statement shows.
 */
function scan(
  fileName: string,
  source: string,
): { readonly calls: number; readonly walks: number } {
  const file = parseSource(fileName, source)
  const names = targetsNames(file)
  const isTargetsCall = (call: ts.CallExpression): boolean => {
    const callee = call.expression
    if (ts.isIdentifier(callee)) return names.has(callee.text)
    return ts.isPropertyAccessExpression(callee) && callee.name.text === 'referenceTargets'
  }
  const functions = namedFunctions(file)
  const callees = callGraph(functions)
  const reads = readers(functions, callees, isTargetsCall)
  const allCalls = callsIn(file)
  const readsTargets = (call: ts.CallExpression): boolean => {
    const callee = calleeName(call)
    return isTargetsCall(call) || (callee !== undefined && reads.has(callee))
  }
  const loops = allCalls.filter((call) => readsTargets(call) && loopEncloses(call)).length
  const recursions = [...reads].filter((name) => reachesItself(name, callees)).length
  return { calls: allCalls.filter(isTargetsCall).length, walks: loops + recursions }
}

const walks = (fileName: string, source: string): number => scan(fileName, source).walks

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
  // The owner's own shape: the call sits in a helper, and the loop calls the helper.
  {
    source: [
      'function frontier(s, g) { return referenceTargets({ ...s, loaded: g }).filter((t) => !g.has(t)) }',
      'for (let w = frontier(s, g); w.length > 0; w = frontier(s, g)) for (const t of w) g.set(t, load(t))',
    ].join('\n'),
    walks: true,
  },
  {
    source: [
      'const next = (s, g) => referenceTargets({ ...s, loaded: g })',
      'const wanted = (s, g) => next(s, g).filter((t) => !g.has(t))',
      'while (wanted(s, g).length) step()',
    ].join('\n'),
    walks: true,
  },
  // Recursion is a loop the scan cannot see as a statement.
  {
    source:
      'function walk(s, g) { for (const t of []) {} const w = referenceTargets(s); if (w.length) walk(next(w), g) }',
    walks: true,
  },
  {
    source:
      'const walk = (s) => { const w = referenceTargets(s); return w.length ? walk(more(w)) : g }',
    walks: true,
  },
  // An alias is the same function under another name.
  {
    source:
      "import { referenceTargets as targets } from 'x'\nwhile (true) { if (!targets(s).length) break }",
    walks: true,
  },
  // A helper called once, a recursion that never reads targets, and an
  // unrelated function of the same name are not walks.
  {
    source:
      'function frontier(s) { return referenceTargets(s) }\nconst key = frontier(s).join("\\n")',
    walks: false,
  },
  { source: 'function visit(n) { for (const c of n.children) visit(c) }', walks: false },
  {
    source: "import { other as referenceTargets } from 'x'\nfor (;;) referenceTargets(s)",
    walks: false,
  },
]

const production = SCAN_ROOTS.flatMap((root) => walkSourceFiles(join(REPO_ROOT, root)))
  .filter((path) => !isTestPath(path))
  .map((path) => ({ path, rel: relative(REPO_ROOT, path).split(sep).join('/') }))
  .filter(({ rel }) => !rel.startsWith(OWNER))

describe('the reference graph is walked in one place', () => {
  it('recognises a hand-written walk and passes a single call', () => {
    const misjudged = FIXTURES.filter(
      (fixture) => walks('fixture.ts', fixture.source) > 0 !== fixture.walks,
    ).map((fixture) => fixture.source)
    expect(misjudged).toEqual([])
  })

  it('reaches the callers it judges', () => {
    // A scan that finds no `referenceTargets` call outside its owner agrees
    // with every rule; the count of callers it did read is what keeps it honest.
    const callers = production.filter(
      ({ path, rel }) => scan(rel, readFileSync(path, 'utf8')).calls > 0,
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
