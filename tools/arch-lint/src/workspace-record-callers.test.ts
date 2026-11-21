/**
 * Who in the daemon's store takes the workspace record as a `LoroDoc`.
 *
 * `getWorkspaceDoc` and `openWorkspaceDocIfStored` hand the cached record out
 * with no loan: whoever holds one holds it past anything the cache does with its
 * entry, which is harmless for a `LoroDoc` and not for an engine lease. A read
 * that only asks the record something goes through a bracket
 * (`withStoredWorkspaceRecord`), which takes the loan and gives it back, so
 * this ledger holds the callers that still take the document itself: the
 * writers, which mutate it, and the tail, which catches it up. It fails in both
 * directions, so a read that moves onto a bracket must lower its count, and a new
 * caller must be answered for.
 */
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { parseSource } from './ast-helpers.js'
import { readRepoSources } from './scan-roots.js'
import { isShippedPath } from './source-scan.js'

const ACCESSORS = new Set(['getWorkspaceDoc', 'openWorkspaceDocIfStored'])
const STORE = 'packages/mcp-server/src/'
/** The cache's own module is where the accessors live. */
const HOME = 'packages/mcp-server/src/server/store/workspace-doc-cache.ts'

/** Shipped files calling an accessor, with how many calls each makes. Shrink-only. */
const CALLERS: Readonly<Record<string, number>> = {
  'packages/mcp-server/src/server/shared-background-work.ts': 1,
  'packages/mcp-server/src/server/store/document-store.ts': 9,
  'packages/mcp-server/src/server/store/file-gc.ts': 1,
  'packages/mcp-server/src/server/store/names-store.ts': 1,
}

/** How many calls to an accessor the file makes, by name: a re-export or an import is not one. */
function callsOf(path: string, text: string): number {
  const source = parseSource(path, text, false)
  let calls = 0
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (ACCESSORS.has(node.expression.text)) calls += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return calls
}

function scan(sources: ReadonlyArray<{ path: string; text: string }>): Record<string, number> {
  const found: Record<string, number> = {}
  for (const { path, text } of sources) {
    if (!path.startsWith(STORE) || path === HOME || !isShippedPath(path)) continue
    const calls = callsOf(path, text)
    if (calls > 0) found[path] = calls
  }
  return found
}

const sources = readRepoSources()
const found = scan(sources)

describe('the callers that take the workspace record as a document', () => {
  it('reaches the daemon store it judges, so a clean scan is not a blind one', () => {
    expect(sources.some(({ path }) => path === HOME)).toBe(true)
    expect(sources.filter(({ path }) => path.startsWith(STORE)).length).toBeGreaterThan(200)
  })

  it('finds no caller outside the ledger, and none calling more than it is allowed', () => {
    const over = Object.entries(found).filter(([path, calls]) => calls > (CALLERS[path] ?? 0))
    expect(over).toEqual([])
  })

  it('keeps no row for a file that stopped calling, nor one counting more than it calls', () => {
    const stale = Object.entries(CALLERS).filter(([path, calls]) => (found[path] ?? 0) !== calls)
    expect(stale).toEqual([])
  })
})

describe('the scan counts calls and nothing else', () => {
  const at = `${STORE}server/store/x.ts`
  it.each([
    ['a call', 'const a = await getWorkspaceDoc(ws, scope)', 1],
    ['both accessors', 'await getWorkspaceDoc(a); await openWorkspaceDocIfStored(b)', 2],
    ['an import', "import { getWorkspaceDoc } from './workspace-doc-cache.js'", 0],
    ['a re-export', "export { getWorkspaceDoc } from './workspace-doc-cache.js'", 0],
    ['a method of the same name', 'store.getWorkspaceDoc(ws)', 0],
  ])('%s', (_name, text, calls) => {
    expect(callsOf(at, text)).toBe(calls)
  })
})
