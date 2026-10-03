/**
 * "Is this host loopback" is decided in ONE place per runtime, and this scan
 * is the executable half of that.
 *
 * It had been written four times with three different sets: the daemon's bind
 * validation, the database location, the hosted app's origin policy and the
 * send-transfer destination check. They drifted in the way a copy does — the
 * destination check omitted `[::1]`, so a keeper on the IPv6 loopback was
 * refused as "not this machine" while the origin policy in the same app
 * called that very host `localhost`.
 *
 * Two homes, not one, because the runtimes cannot share a module: the web app
 * may not import `mcp-server`, and its set is the `URL.hostname` spelling
 * (brackets kept, no bare `::1`) where a bind host is written bare.
 *
 * The scan reads code with comments removed and looks for the spelling a copy
 * takes: a `Set` literal, or an array literal asked `.includes(`, holding the
 * `127.0.0.1` string. Both homes are allowlisted, and an entry that stops
 * matching fails as stale like every allowlist here.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'
import { stripComments } from './strip-comments.js'

const HOMES: Readonly<Record<string, string>> = {
  'packages/mcp-server/src/shared/loopback-host.ts': 'the daemon half, bind-host and URL spellings',
  'apps/web/src/lib/loopback-host.ts': 'the browser half, `URL.hostname` spelling',
}

const LOOPBACK_LITERAL = String.raw`['"]127\.0\.0\.1['"]`
/** `new Set(['localhost', '127.0.0.1'])`, with or without type arguments. */
const SET_LITERAL = new RegExp(
  String.raw`new\s+Set\s*(?:<[^>()]*>)?\s*\(\s*\[[^\]]*${LOOPBACK_LITERAL}`,
)
/** `['localhost', '127.0.0.1'].includes(host)`. */
const ARRAY_INCLUDES = new RegExp(String.raw`\[[^\]]*${LOOPBACK_LITERAL}[^\]]*\]\s*\.includes\s*\(`)

function loopbackSets(source: string): string[] {
  const code = stripComments(source)
  return [SET_LITERAL, ARRAY_INCLUDES].flatMap((pattern) => {
    const hit = pattern.exec(code)
    return hit ? [hit[0]] : []
  })
}

const files = SCAN_ROOTS.flatMap((root) => walkSourceFiles(join(REPO_ROOT, root))).filter(
  (path) => !isTestPath(path),
)
const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')
const sourceOf = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')

describe('a loopback host is recognised in one place per runtime', () => {
  it('scans a tree worth scanning', () => {
    expect(files.length).toBeGreaterThan(500)
    for (const home of Object.keys(HOMES)) expect(files.map(relOf)).toContain(home)
  })

  it('no shipped source writes its own loopback set', () => {
    const hits = files
      .map(relOf)
      .filter((rel) => HOMES[rel] === undefined)
      .flatMap((rel) => loopbackSets(sourceOf(rel)).map((spelling) => `${rel}: ${spelling}`))
    expect(
      hits,
      'call `isLoopbackHost` (packages/mcp-server/src/shared/loopback-host.ts) or `isLoopbackHostname` (apps/web/src/lib/loopback-host.ts): a second set drifts, and the web copy once refused `[::1]`',
    ).toEqual([])
  })

  it('names the two spellings it looks for', () => {
    expect(loopbackSets("const s = new Set(['localhost', '127.0.0.1'])")).toHaveLength(1)
    expect(
      loopbackSets("const s: ReadonlySet<string> = new Set<string>(['127.0.0.1'])"),
    ).toHaveLength(1)
    expect(loopbackSets("if (['localhost', '127.0.0.1'].includes(host)) x()")).toHaveLength(1)
  })

  it('does not read a comment, or an unrelated list, as a loopback set', () => {
    expect(loopbackSets("// new Set(['127.0.0.1'])\nconst x = 1")).toEqual([])
    expect(loopbackSets("const pages = ['http://127.0.0.1/*']")).toEqual([])
    expect(loopbackSets("const s = new Set(['a', 'b'])")).toEqual([])
  })

  it('every home still holds a set', () => {
    const stale = Object.keys(HOMES).filter((rel) => loopbackSets(sourceOf(rel)).length === 0)
    expect(stale, 'a home that stops holding the set is no longer the one place').toEqual([])
  })
})
