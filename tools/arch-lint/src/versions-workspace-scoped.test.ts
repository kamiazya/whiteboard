/**
 * Every read, update and delete of the daemon's `versions` table names the
 * workspace it acts on.
 *
 * The table's key is a global version id, but its rows belong to a
 * (workspace, document) pair, and a documentId is NOT unique across
 * workspaces: a promote carries the browser's ids into the daemon, and a
 * member can write any id into their own workspace's synced trash. So a
 * statement filtered by documentId alone reaches every workspace holding
 * that id — which is how a trash purge in one workspace once deleted another
 * workspace's whole history of a document. Nothing about such a statement
 * looks wrong; the scan is what makes the missing filter visible.
 *
 * Migrations are out of scope on purpose: they rewrite every workspace's rows
 * by design. Inserts are out of scope because they carry the workspace in
 * their values, not in a filter.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isExcludedPath, REPO_ROOT, relativeToRepo, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const STATEMENT_START = /\.(selectFrom|updateTable|deleteFrom)\(\s*'versions'\s*\)/g
const STATEMENT_END = /\.execute(?:TakeFirst(?:OrThrow)?)?\(/
const WORKSPACE_FILTER = /\.where\(\s*'(?:versions\.)?workspaceId'\s*,/

/** Each versions statement's chain, from the table to its execute, and whether it is scoped. */
function versionsStatements(source: string): { chain: string; scoped: boolean }[] {
  const found: { chain: string; scoped: boolean }[] = []
  for (const match of source.matchAll(STATEMENT_START)) {
    const rest = source.slice(match.index)
    const end = STATEMENT_END.exec(rest)
    // A chain with no execute in sight is one this scan cannot judge, so it
    // reports it unscoped rather than guessing.
    const chain = end === null ? rest.slice(0, 200) : rest.slice(0, end.index)
    found.push({ chain, scoped: end !== null && WORKSPACE_FILTER.test(chain) })
  }
  return found
}

const files = SCAN_ROOTS.flatMap((root) => walkSourceFiles(join(REPO_ROOT, root))).filter(
  (path) =>
    !isExcludedPath(path) &&
    !isTestPath(path) &&
    relativeToRepo(path).startsWith('packages/mcp-server/src/') &&
    !relativeToRepo(path).includes('/store/db/migrations/'),
)

describe('versions statements are scoped to a workspace', () => {
  it('tells a scoped chain from one filtered by document id alone', () => {
    const scoped = versionsStatements(
      "await db.deleteFrom('versions').where('workspaceId', '=', w).where('documentId', '=', d).execute()",
    )
    const unscoped = versionsStatements(
      "await db.deleteFrom('versions').where('documentId', '=', d).execute()",
    )
    const later = versionsStatements(
      "db.selectFrom('versions').select('id').where('id', '=', i).execute(); x.where('workspaceId', '=', w)",
    )
    const joined = versionsStatements(
      "db.updateTable('versions').set({}).where('versions.workspaceId', '=', w).executeTakeFirst()",
    )
    expect(scoped.map((s) => s.scoped)).toEqual([true])
    expect(unscoped.map((s) => s.scoped)).toEqual([false])
    // A filter after the statement's execute belongs to some other statement.
    expect(later.map((s) => s.scoped)).toEqual([false])
    expect(joined.map((s) => s.scoped)).toEqual([true])
  })

  it('finds no versions statement in the daemon that names no workspace', () => {
    const all = files.flatMap((path) =>
      versionsStatements(readFileSync(path, 'utf8')).map((statement) => ({
        file: relativeToRepo(path),
        ...statement,
      })),
    )
    // The subject is present: the version store alone holds more than this.
    expect(all.length).toBeGreaterThan(12)
    expect(
      all.filter((statement) => !statement.scoped).map(({ file, chain }) => `${file}: ${chain}`),
    ).toEqual([])
  })
})
