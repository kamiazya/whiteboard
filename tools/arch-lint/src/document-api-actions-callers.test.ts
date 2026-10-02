/**
 * Every action in `DOCUMENT_API_ACTIONS` has a first-party CALLER, or is
 * ledgered here with why it has none.
 *
 * `document-url-actions.test.ts` (mcp-server) holds one direction: a route is
 * registered behind every action. This is the other one. An action nobody
 * calls is a route the daemon serves, fuzzes, documents in its URL builder and
 * pins in a URL table, for a client that does not exist — and every one of
 * those gates stays green, because each asserts something about the route,
 * not about anyone using it.
 *
 * A caller is a call whose LAST argument is the action's string literal, in a
 * production file that names `documentApiUrl`. That reads `documentApiUrl(ws,
 * path, 'snapshot')` and a wrapper that fixes the action
 * (`canvasDocUrl(base, doc, 'update')`) alike, and it does not read the
 * server's own `onDocumentAction(app, 'get', 'snapshot', …)`, which is a
 * registration and not a use. The source is read as an AST, so prose naming a
 * call is not one.
 *
 * Guarded from both sides, like every allowlist in this tool: an entry for a
 * name that is no longer an action, or for one that has since gained a
 * caller, fails — so the ledger cannot outlive the debt it names. The count is
 * a ceiling that only falls.
 */
import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, relativeToRepo, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const ACTIONS_FILE = 'packages/daemon-client/src/api-contracts/document-url.ts'

const NO_CALLER_REASON_EXPORT =
  'no first-party caller; maintainer decision open (ADR-0038 export projection): expose through wb_scene_render/CLI, document as socket-only scripting API, or delete'

/** Actions the daemon serves that nothing in the product calls, each with why. */
const LEDGER: Readonly<Record<string, string>> = {
  'client-count':
    'only the extension bridge smoke (apps/extension/scripts/smoke-kit.mjs) calls it, to observe that a page attached its stream; no product caller, so it stays a diagnostic until one reads it',
  export: NO_CALLER_REASON_EXPORT,
  'export-svg': NO_CALLER_REASON_EXPORT,
  exists:
    'no first-party caller; the route is deleted end to end by the commit that follows this one',
}

/** The ledger may shrink; raising it is a decision made in a diff. */
const LEDGER_CEILING = 4

const SCAN_DIRS: readonly string[] = [
  ...SCAN_ROOTS.filter((root) => !root.startsWith('tools/')),
  'apps/extension/src',
]

function parse(source: string, name: string): ts.SourceFile {
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true)
}

/** The string members of `DOCUMENT_API_ACTIONS`, read off the declaration. */
function declaredActions(): string[] {
  const file = parse(readFileSync(join(REPO_ROOT, ACTIONS_FILE), 'utf8'), ACTIONS_FILE)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'DOCUMENT_API_ACTIONS' &&
      node.initializer !== undefined
    ) {
      const array = ts.isAsExpression(node.initializer) ? node.initializer.expression : null
      if (array !== null && ts.isArrayLiteralExpression(array)) {
        for (const element of array.elements) {
          if (ts.isStringLiteral(element)) found.push(element.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** Whether `source` names `documentApiUrl` and calls something with `action` last. */
function callsWithAction(source: string): Set<string> {
  const file = parse(source, 'scanned.ts')
  let namesBuilder = false
  const literals = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'documentApiUrl') namesBuilder = true
    if (ts.isCallExpression(node)) {
      const last = node.arguments.at(-1)
      if (last !== undefined && ts.isStringLiteralLike(last)) literals.add(last.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return namesBuilder ? literals : new Set()
}

function isProduction(absolute: string): boolean {
  const segments = absolute.split(sep)
  return (
    !isTestPath(absolute) &&
    !(segments.at(-1) ?? '').startsWith('_test-') &&
    relativeToRepo(absolute) !== ACTIONS_FILE
  )
}

function calledActions(): { readonly called: Set<string>; readonly files: number } {
  const called = new Set<string>()
  let files = 0
  for (const dir of SCAN_DIRS) {
    for (const absolute of walkSourceFiles(join(REPO_ROOT, dir)).filter(isProduction)) {
      files += 1
      for (const action of callsWithAction(readFileSync(absolute, 'utf8'))) called.add(action)
    }
  }
  return { called, files }
}

describe('every document API action has a first-party caller', () => {
  const actions = declaredActions()
  const { called, files } = calledActions()

  it('reads the declared actions and a real production population', () => {
    // A scan that stopped finding either side would call every action
    // uncalled, or none, and both read as a verdict on the actions.
    expect(actions).toContain('snapshot')
    expect(actions.length).toBeGreaterThanOrEqual(4)
    expect(files).toBeGreaterThan(500)
    expect(called.has('snapshot')).toBe(true)
  })

  it('has a caller for each action, or says in LEDGER why it has none', () => {
    const unexplained = actions.filter((action) => !called.has(action) && !(action in LEDGER))
    expect(
      unexplained,
      `${unexplained.join(', ')}: served by the daemon and called by nothing in apps/web, apps/extension or packages. Delete the action end to end (route, response schema, fuzz rule, URL-table entry), or add a caller, or enter it in LEDGER with the decision that is open.`,
    ).toEqual([])
  })

  it('names only actions that still exist and still have no caller', () => {
    const stale = Object.keys(LEDGER).filter(
      (action) => !actions.includes(action) || called.has(action),
    )
    expect(stale, `${stale.join(', ')}: no longer an uncalled action; delete the entry.`).toEqual(
      [],
    )
  })

  it('gives every entry a reason, not a word', () => {
    expect(Object.entries(LEDGER).filter(([, reason]) => reason.split(/\s+/).length < 8)).toEqual(
      [],
    )
  })

  it('only shrinks', () => {
    expect(Object.keys(LEDGER).length).toBe(LEDGER_CEILING)
  })
})

describe('what the scan counts as a call', () => {
  it('leaves out tests, their helpers and the builder itself', () => {
    const at = (relative: string) => join(REPO_ROOT, relative)
    expect(isProduction(at('apps/web/src/lib/daemon-api-client.ts'))).toBe(true)
    expect(isProduction(at('apps/web/src/lib/daemon-api-client.test.ts'))).toBe(false)
    expect(isProduction(at('apps/web/src/test-utils/fake-daemon-fetch.ts'))).toBe(false)
    expect(isProduction(at('packages/mcp-server/src/server/_test-route-fuzz-lane.ts'))).toBe(false)
    expect(isProduction(at(ACTIONS_FILE))).toBe(false)
  })

  it('reads a call to the builder with the action last', () => {
    expect([...callsWithAction(`documentApiUrl(ws, path, 'snapshot')`)]).toEqual(['snapshot'])
  })

  it('reads a wrapper that fixes the action, in a file that names the builder', () => {
    expect([
      ...callsWithAction(`import { documentApiUrl } from 'x'\ncanvasDocUrl(base, doc, 'update')`),
    ]).toEqual(['update'])
  })

  it('does not read prose or a file that never names the builder', () => {
    expect(callsWithAction(`// documentApiUrl(ws, path, 'export')\nconst a = 1`).size).toBe(0)
    expect(callsWithAction(`onDocumentAction(app, 'get', 'snapshot')`).size).toBe(0)
  })
})
