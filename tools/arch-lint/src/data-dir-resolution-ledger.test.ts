/**
 * Every place the CLI picks a data directory has answered whether a config
 * file's `dataDir` reaches it.
 *
 * Why a ledger. `dataDir` in a config file was layered under the environment
 * by `daemon run` alone, so the daemon landed in the file's directory while
 * `daemon status`, `stop`, `doctor`, the native host and the stdio server —
 * each resolving `parsed.dataDir ?? resolveDefaultDataDir(env)` — looked in
 * `~/.whiteboard` and answered "record not found". A command added tomorrow
 * that resolves its own directory would repeat it with no test failing, since
 * each command's tests pass a `dataDir` in. The behavioural half is
 * `dispatcher-config-file.test.ts`; this is the half that notices a new
 * resolver.
 *
 * Both-sided: an entry whose file no longer calls the resolver fails, so the
 * ledger cannot outlive what it classifies.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, stripCommentsAndStrings, walkSourceFiles } from './source-scan.js'

const SCANNED = 'packages/mcp-server/src'
const RESOLVER = 'packages/mcp-server/src/daemon/data-dir.ts'

/** `resolveDefaultDataDir(` as a call, not an import or a comment. */
const CALL = /\bresolveDefaultDataDir\s*\(/

const LOCAL =
  "layered: reached only through the dispatcher's main(), which loads the config file into the environment before any command runs"
const SERVER =
  "server mode: a flag or the environment only — a container holds no daemon config file, and `server *` is not one of the dispatcher's `locatesLocalDaemon` commands"

const LEDGER: Readonly<Record<string, string>> = {
  'packages/mcp-server/src/cli/dispatcher.ts': `${LOCAL}; the \`server *\` branches in it are ${SERVER}`,
  'packages/mcp-server/src/cli/native-host.ts': LOCAL,
  'packages/mcp-server/src/cli/operator-command.ts': SERVER,
  'packages/mcp-server/src/cli/server-backup.ts': SERVER,
  'packages/mcp-server/src/cli/server-doctor.ts': SERVER,
  'packages/mcp-server/src/cli/server-run.ts': SERVER,
  'packages/mcp-server/src/cli/server-status.ts': SERVER,
  'packages/mcp-server/src/cli/server-stop.ts': SERVER,
}

const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')
const callers = walkSourceFiles(join(REPO_ROOT, SCANNED))
  .filter((path) => !isTestPath(path))
  .map(relOf)
  .filter((rel) => rel !== RESOLVER)
  .filter((rel) => CALL.test(stripCommentsAndStrings(readFileSync(join(REPO_ROOT, rel), 'utf8'))))

describe('every data-directory resolver in the CLI is classified against the config file', () => {
  it('finds the resolvers it classifies', () => {
    // An empty scan agrees with any ledger; the count says the walk reached them.
    expect(callers.length).toBeGreaterThan(5)
  })

  it('has no unclassified caller of resolveDefaultDataDir', () => {
    const unclassified = callers.filter((rel) => LEDGER[rel] === undefined)
    expect(
      unclassified,
      'a command that locates the local daemon must resolve its directory AFTER `main()` has layered the config file (add it to `locatesLocalDaemon`), and one that must not says why here',
    ).toEqual([])
  })

  it('has no entry for a file that stopped calling it', () => {
    const stale = Object.keys(LEDGER).filter((rel) => !callers.includes(rel))
    expect(stale, 'delete the entry: the file no longer resolves a data directory').toEqual([])
  })
})
