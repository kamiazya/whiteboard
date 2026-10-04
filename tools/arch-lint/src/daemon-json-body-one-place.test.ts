/**
 * A daemon route reads a JSON request body through `readJsonBody`
 * (`packages/mcp-server/src/server/routes/read-json-body.ts`), and nowhere
 * else.
 *
 * Fourteen routes read the body fourteen ways, and "this is not JSON" was
 * answered four different ways across them — a refusal keyed on whichever
 * route a caller happened to hit. A client reading the answer through
 * `apiErrorReason` cannot tell those apart from a real difference, so the
 * reader owns the one sentence per error family and a route supplies only
 * what is its own: the schema and its sentence for the wrong shape.
 *
 * Two shapes are read from the syntax tree, so a line break, an alias or a
 * nested call cannot walk past:
 * - a call to `.json()`, `.text()`, `.formData()` or `.parseBody()` on
 *   anything reached through a `.req` property (`c.req.json()`,
 *   `c.req.raw.clone().json()`);
 * - a `JSON.parse(` call.
 *
 * Raw-bytes routes (`c.req.arrayBuffer()`) are not JSON reads and are not
 * matched. Tests are out of scope.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { parseSource, unwrapExpression } from './ast-helpers.js'
import { REPO_ROOT } from './scan-roots.js'
import { isShippedPath, walkSourceFiles } from './source-scan.js'

const SERVER_ROOT = 'packages/mcp-server/src/server'
const OWNER = `${SERVER_ROOT}/routes/read-json-body.ts`

/** Sites that read a body themselves on purpose, each with why the reader cannot serve it. */
const LEFT_IN_PLACE: Readonly<Record<string, string>> = {
  [`${SERVER_ROOT}/routes/mcp.ts`]:
    "a JSON-RPC envelope is parsed once and handed to both transports, and anything that is not a JSON POST reads as absent rather than refused, so the answer to unparseable input is the MCP transport's, not a 400",
}

const BODY_READERS: ReadonlySet<string> = new Set(['json', 'text', 'formData', 'parseBody'])

/** Whether `.req` appears anywhere along the receiver chain, through calls and member accesses. */
function reachedThroughReq(node: ts.Expression): boolean {
  let current: ts.Expression = node
  for (;;) {
    if (ts.isPropertyAccessExpression(current)) {
      if (current.name.text === 'req') return true
      current = current.expression
    } else if (ts.isCallExpression(current)) {
      current = current.expression
    } else if (unwrapExpression(current) !== current) {
      current = unwrapExpression(current)
    } else {
      return false
    }
  }
}

/**
 * How many hand-written body reads `source` holds. `JSON.parse` is a body
 * read only under `routes/`: elsewhere the daemon parses its own files with
 * it, which no request body ever reaches.
 */
function countBodyReads(fileName: string, source: string): number {
  const parsesJson = fileName.replaceAll('\\', '/').includes(`${SERVER_ROOT}/routes/`)
  const file = parseSource(fileName, source, false)
  let found = 0
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { expression: receiver, name } = node.expression
      if (BODY_READERS.has(name.text) && reachedThroughReq(receiver)) found += 1
      else if (
        parsesJson &&
        name.text === 'parse' &&
        ts.isIdentifier(receiver) &&
        receiver.text === 'JSON'
      ) {
        found += 1
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

const ROUTE_FILE = `${SERVER_ROOT}/routes/fixture.ts`

const FIXTURES: readonly { readonly source: string; readonly reads: number }[] = [
  { source: 'const body = await c.req.json()', reads: 1 },
  { source: 'const body = await c.req.json().catch(() => null)', reads: 1 },
  { source: 'const raw = await c.req.text()', reads: 1 },
  { source: 'const raw = await context.req.text()', reads: 1 },
  { source: 'const body = await c.req.raw.clone().json()', reads: 1 },
  { source: 'const body = await (c.req as Req).json()', reads: 1 },
  { source: 'const form = await c.req.formData()', reads: 1 },
  { source: 'const form = await c.req.parseBody()', reads: 1 },
  { source: 'const value = JSON.parse(text)', reads: 1 },
  { source: 'const raw = await c.req.text()\nconst value = JSON.parse(raw)', reads: 2 },
  { source: 'const bytes = await c.req.arrayBuffer()', reads: 0 },
  { source: 'return c.json({ ok: true }, 200)', reads: 0 },
  { source: 'const body = await response.json()', reads: 0 },
  { source: 'const text = await response.text()', reads: 0 },
  { source: 'const header = c.req.header("content-type")', reads: 0 },
  { source: 'const json = JSON.stringify(value)', reads: 0 },
  { source: '// c.req.json()', reads: 0 },
  { source: 'log.warn("c.req.json() failed")', reads: 0 },
]

const shipped = walkSourceFiles(join(REPO_ROOT, SERVER_ROOT))
  .filter((path) => isShippedPath(path))
  .map((path) => ({ path, rel: relative(REPO_ROOT, path).split(sep).join('/') }))

describe('a daemon route reads a JSON request body in one place', () => {
  it('recognises each way of reading a body, and not a lookalike or a mention', () => {
    for (const { source, reads } of FIXTURES) {
      // Inside an async function, where `await` is the keyword it is in a route.
      const inRoute = `async function handler() {\n${source}\n}`
      expect(countBodyReads(ROUTE_FILE, inRoute), source).toBe(reads)
    }
  })

  it('reads JSON.parse as a body read under routes/ only', () => {
    const source = 'const value = JSON.parse(text)'
    expect(countBodyReads(ROUTE_FILE, source)).toBe(1)
    expect(countBodyReads(`${SERVER_ROOT}/security/fixture.ts`, source)).toBe(0)
  })

  it('scans a tree worth scanning, and the owner is in it', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(shipped.length).toBeGreaterThan(100)
    expect(shipped.some(({ rel }) => rel === OWNER)).toBe(true)
    expect(countBodyReads(OWNER, readFileSync(join(REPO_ROOT, OWNER), 'utf8'))).toBeGreaterThan(0)
  })

  const outside = shipped
    .filter(({ rel }) => rel !== OWNER)
    .map(({ path, rel }) => ({ rel, reads: countBodyReads(path, readFileSync(path, 'utf8')) }))
    .filter(({ reads }) => reads > 0)

  it('has no body read outside the reader beyond the ones left in place', () => {
    expect(
      outside.map(({ rel }) => rel).filter((rel) => !(rel in LEFT_IN_PLACE)),
      'read the body with `readJsonBody`, so "not JSON" has one answer per error family',
    ).toEqual([])
  })

  it('lists only files that still read a body themselves', () => {
    // An entry that no longer reads one is a standing permission for the next
    // route to, and nothing else would notice it had outlived its reason.
    const holding = new Set(outside.map(({ rel }) => rel))
    expect(Object.keys(LEFT_IN_PLACE).filter((rel) => !holding.has(rel))).toEqual([])
  })
})
