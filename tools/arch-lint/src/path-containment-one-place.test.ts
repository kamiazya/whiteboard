/**
 * "Is this path really inside that directory" is answered in ONE place for
 * mcp-server: `shared/path-containment.ts`.
 *
 * A containment check that resolves symlinks needs `realpath`, and the first
 * thing a second author writes with it is a private walk that canonicalises
 * only the part of the path they thought of. `output-path.ts` did: it resolved
 * the parent but never the path itself, so a symlink AT the output path, or a
 * dangling one, carried a write out of the exports directory. The shared walk
 * resolves the whole path, keeps the missing tail, and can refuse a symlink at
 * the deepest existing component.
 *
 * The primitive is the tell, so the rule is on `realpath` itself rather than on
 * a helper's shape: a call outside the shared module is either a use that is
 * not containment (ledgered with the reason) or the second walk this exists to
 * stop. A ledgered count is exact in both directions, so an entry cannot
 * outlive the code it excuses.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countNamedUses } from './named-use-scan.js'
import { isExcludedPath, REPO_ROOT, relativeToRepo, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const SHARED_WALK = 'packages/mcp-server/src/shared/path-containment.ts'

const REALPATH_NAMES = ['realpath', 'realpathSync']

/**
 * Calls outside the shared module, by file, with what each one is for.
 *
 * The sweeper's checks all require the path to EXIST (a missing entry is
 * skipped, not judged), compare against a data directory resolved once per
 * pass, and log a distinct reason per branch; the shared walk answers none of
 * those. The other two are not containment at all.
 */
const LEDGER: Readonly<Record<string, { calls: number; why: string }>> = {
  'packages/mcp-server/src/server/store/file-gc-sweeper.ts': {
    calls: 4,
    why: 'existence-required containment of each workspace directory against a once-resolved data dir, one log reason per branch',
  },
  'packages/mcp-server/src/server/mcp/tarball.distribution-impl.ts': {
    calls: 1,
    why: 'the cwd a packed install runs in; not a containment check',
  },
  'packages/mcp-server/src/cli/native-host.ts': {
    calls: 1,
    why: 'which file this process was started from; not a containment check',
  },
}

/** Uses of `realpath`/`realpathSync` however spelled: bare, qualified, `.native`, bracketed or aliased. */
function calls(source: string, fileName = 'fixture.ts'): number {
  return countNamedUses(fileName, source, REALPATH_NAMES)
}

const files = SCAN_ROOTS.flatMap((root) => walkSourceFiles(join(REPO_ROOT, root))).filter(
  (path) => !isExcludedPath(path),
)
const mcpFiles = files.filter(
  (path) => relativeToRepo(path).startsWith('packages/mcp-server/src/') && !isTestPath(path),
)

describe('path containment is answered in one place', () => {
  it('recognises a realpath call and passes prose and neighbours through', () => {
    expect(calls('const p = await realpath(target)')).toBe(1)
    expect(calls('const p = realpathSync(target)')).toBe(1)
    expect(calls('const p = await fs.realpath(target)')).toBe(1)
    expect(calls("import { realpath } from 'node:fs/promises'")).toBe(0)
    expect(calls('// realpath(target) in a comment')).toBe(0)
    expect(calls('const p = realpathNearestExisting(target)')).toBe(0)
    expect(calls("import { realpath as rp } from 'node:fs/promises'\nawait rp(target)")).toBe(1)
    expect(calls('const p = fs.realpathSync.native(target)')).toBe(1)
    expect(calls("const p = await fsp['realpath'](target)")).toBe(1)
  })

  it('scans a tree worth scanning, and the shared walk still holds the primitive', () => {
    expect(mcpFiles.length).toBeGreaterThan(200)
    expect(calls(readFileSync(join(REPO_ROOT, SHARED_WALK), 'utf8'), SHARED_WALK)).toBe(1)
  })

  it('no mcp-server file outside the shared walk calls realpath beyond its ledgered uses', () => {
    const found: Record<string, number> = {}
    for (const path of mcpFiles) {
      const rel = relativeToRepo(path)
      if (rel === SHARED_WALK) continue
      const count = calls(readFileSync(path, 'utf8'), path)
      if (count > 0) found[rel] = count
    }
    const ledgered = Object.fromEntries(
      Object.entries(LEDGER).map(([rel, entry]) => [rel, entry.calls]),
    )
    expect(found).toEqual(ledgered)
  })
})
