/**
 * Prose outlives the code it describes, and nothing re-reads it. Two kinds of
 * stale claim have each shipped in `docs/` with every test green, and both are
 * held here:
 *
 * - an environment variable the operator reference lists that nothing shipped
 *   reads (`WHITEBOARD_CHROME_PATH`, read only by the test launcher, sat in
 *   the operator table with no way to take effect for an operator);
 * - a sentence about something the code no longer does or never did — a
 *   retired entry point, a retired layout, a method that no longer exists.
 *
 * The second list is a ledger of RETIRED claims, each with the reason it is
 * wrong. A claim goes in when it was found wrong and fixed; the guard keeps it
 * fixed. Each entry is held from the other side as well: its pattern must
 * still match something in its own `example`, so a regex that quietly stopped
 * matching cannot read as a clean docs tree.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, workspaceDirs } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const DOCS = join(REPO_ROOT, 'docs')

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    return entry.name.endsWith('.md') ? [path] : []
  })
}

/** Decision records are history: they name the shapes as they stood when decided. */
const docs = markdownFiles(DOCS)
  .filter((path) => !path.includes(`${join('docs', 'contributing', 'adr')}`))
  .map((path) => ({ rel: relative(REPO_ROOT, path), text: readFileSync(path, 'utf-8') }))

describe('the operator reference lists only variables something shipped reads', () => {
  const reference = readFileSync(join(DOCS, 'reference/configuration.md'), 'utf-8')
  const table = reference.slice(
    reference.indexOf('## Environment variables'),
    reference.indexOf('## Auto-opening the browser'),
  )
  const documented = [...table.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((m) => m[1] as string)

  const shipped = workspaceDirs()
    .flatMap((dir) => walkSourceFiles(join(REPO_ROOT, dir, 'src')))
    .filter((path) => !isTestPath(path))
    .map((path) => readFileSync(path, 'utf-8'))
    .join('\n')

  it('reads a real table and a real source tree', () => {
    expect(documented.length).toBeGreaterThan(15)
    expect(documented).toContain('WHITEBOARD_DATA_DIR')
    expect(shipped.length).toBeGreaterThan(100_000)
  })

  it('has a reader in shipped source for every documented variable', () => {
    expect(documented.filter((name) => !shipped.includes(name))).toEqual([])
  })
})

interface RetiredClaim {
  readonly pattern: RegExp
  readonly why: string
  /** Text the pattern must match, so the entry cannot go inert unnoticed. */
  readonly example: string
}

const RETIRED: readonly RetiredClaim[] = [
  {
    pattern: /dist\/server\/index\.js/,
    why: 'a module with no process role: running it exits 0 silently. The packaged daemon is `whiteboard daemon run`; the dev daemon is `dist/server/daemon-entry.js`',
    example: 'node dist/server/index.js',
  },
  {
    pattern: /\bsaveCanvas\b/,
    why: 'no such call exists; documents are edited through `wb_workspace_edit` and the sync stream',
    example: 'the matching `saveCanvas` call',
  },
  {
    pattern: /~\/\.whiteboard\/\{workspaceId\}/,
    why: 'a data directory holds one SQLite database plus `tenants/<tenantId>/...`, not a directory per workspace id (see the Storage layout section)',
    example: 'Lives under `~/.whiteboard/{workspaceId}/`',
  },
  {
    pattern: /\/w\/\{workspaceId\}\/document\//,
    why: 'the route is `/w/<workspace>/d/<path>` (`apps/web/src/lib/app-routes.ts`)',
    example: 'opens `/w/{workspaceId}/document/{path}`',
  },
  {
    pattern: /no outbound network requests today/i,
    why: 'font installation and `search fetch-model` both fetch from the network',
    example: 'makes **no outbound network requests today**',
  },
  {
    pattern: /edge with a free end|point-ended edge/i,
    why: 'an edge cannot end in empty space; a drawn stroke with a free end is a line, and it is carried in `x-whiteboard.lines` (extended) or dropped whole (strict) like any other ink',
    example: 'one thing is dropped: an edge with a free end',
  },
  {
    pattern: /request names a `background` of its own/,
    why: 'the export routes take no `background` field: a request carrying one is refused as an unrecognized key, and the paper follows the theme and the mode asked for',
    example: 'unless the request names a `background` of its own',
  },
  {
    pattern: /\.dev-data\.bak/,
    why: 'a sibling of `.dev-data/` is not git-ignored and would hold the dev token; back up under `tmp/`',
    example: 'cp -r .dev-data .dev-data.bak',
  },
]

describe('docs carry no retired claim', () => {
  it.each(RETIRED)('still matches its own example: $why', ({ pattern, example }) => {
    expect(pattern.test(example)).toBe(true)
  })

  it('reads the docs tree', () => {
    expect(docs.length).toBeGreaterThan(20)
  })

  it.each(RETIRED)('is absent from every doc: $pattern', ({ pattern, why }) => {
    const hits = docs.filter((doc) => pattern.test(doc.text)).map((doc) => doc.rel)
    expect(hits, `${why}`).toEqual([])
  })
})
