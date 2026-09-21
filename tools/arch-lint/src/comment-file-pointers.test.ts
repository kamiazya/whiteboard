import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// A backticked filename in a comment is a POINTER, and a pointer at a file
// that is gone sends the next reader somewhere that does not exist. It is
// invisible to every other rung: the code compiles, the tests pass, and a
// grep for the name finds exactly the comment that is wrong.
//
// `mock-specifiers.test.ts` records the same blind spot one door over — a
// `vi.mock('./x.js')` specifier is a string, not an import, so it keeps
// pointing at a deleted module and mocks nothing. Both are resolved rather
// than grepped, for the same reason.
//
// Measured when this landed: 18 unresolvable names, of which 8 were stale
// pointers and 10 were deliberate. The first probe said 41 — it counted
// suffix patterns (`.browser.test.tsx`), placeholders (`./pages/X.tsx`) and
// files outside its scan roots (`vitest.setup.ts`, at a package root). A
// scan that over-reports reads as thorough, so the exclusions below are
// shape rules rather than an allowlist, and only what survives them is a
// decision somebody has to make.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')

/** Every tracked path, which is what a pointer may name. */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\n')
    .filter(Boolean)
}

/**
 * A backticked name is a POINTER only if it could name a file at all.
 *
 * Three shapes are not pointers and are excluded by their shape rather than
 * by name, so a new one of each costs nobody an entry:
 * - a suffix pattern (`.browser.test.tsx`) — prose about a naming convention
 * - a single-letter placeholder (`./pages/X.tsx`) — an illustration
 * - an absolute-looking fragment (`/src/components/Thing.tsx`) — a worked
 *   example of a path transformation, not a path
 */
function isPointer(name: string): boolean {
  if (name.startsWith('/')) return false
  if (name.startsWith('.') && !name.startsWith('./')) return false
  return !/(^|\/)[A-Z]\.tsx?$/.test(name)
}

/**
 * Names that resolve to nothing AND are meant to. Each says why, because a
 * bare exemption is the omission with a word in front of it.
 */
const DELIBERATE: Record<string, string> = {
  'apps/web/src/lib/keeper-parity.test.ts#src/hooks/useBranches.ts':
    'the comment is about its ABSENCE — it stopped reaching the daemon and the ledger refuses an entry naming a module that no longer does',
  'apps/web/src/lib/keeper-parity.test.ts#branches-backend.ts':
    'same sentence: what the branch surface WAS, kept so the reason the entry went is readable',
  'apps/web/src/lib/provider.ts#provider.capability-reach.test.ts':
    'past tense about a deleted guard — "could never have refused" is the argument for deleting it, and a present-tense pointer would invert it',
  'packages/mcp-server/src/server/release/stryker-targets.test.ts#api-contracts/libraries.ts':
    'the comment IS the record that these three names went stale while the score stayed plausible; correcting them destroys what it says',
  'packages/mcp-server/src/server/release/stryker-targets.test.ts#routes/canvas-thumbnail.ts':
    'same sentence',
  'packages/mcp-server/src/server/release/stryker-targets.test.ts#routes/canvas-output-path-error.ts':
    'same sentence',
  'tools/arch-lint/src/architecture-map.ts#routes/branches.ts':
    'ADR-0029 retired the branch and the comment says the route no longer exists — debt paid by deletion, recorded',
  'tools/arch-lint/src/architecture-map.ts#routes/document/thumbnails.ts':
    'same sentence: the route went with the version row thumbnail',
  'packages/mcp-server/src/server/store/db/migrations/0011-import-fs-blobs.ts#sweep-imported-fs-blobs.ts':
    "a migration's own text is history and is never rewritten (.claude/rules/vocabulary.md); the sweeper existed when this was written (#858)",
}

interface Pointer {
  readonly key: string
  readonly file: string
  readonly name: string
}

function unresolvedPointers(): Pointer[] {
  const tracked = trackedFiles()
  const byBasename = new Set(tracked.map((path) => basename(path)))
  const found: Pointer[] = []
  const seen = new Set<string>()
  for (const file of tracked.filter((path) => /\.tsx?$/.test(path))) {
    for (const line of readFileSync(join(REPO_ROOT, file), 'utf8').split('\n')) {
      if (!/^\s*(\/\/|\*|\/\*)/.test(line)) continue
      for (const match of line.matchAll(/`([A-Za-z0-9._/-]+\.tsx?)`/g)) {
        const name = match[1] ?? ''
        if (!isPointer(name)) continue
        const resolves =
          tracked.some((path) => path === name || path.endsWith(`/${name}`)) ||
          byBasename.has(basename(name))
        if (resolves) continue
        const key = `${file}#${name}`
        if (seen.has(key)) continue
        seen.add(key)
        found.push({ key, file, name })
      }
    }
  }
  return found
}

const UNRESOLVED = unresolvedPointers()

describe('a backticked filename in a comment names a file that exists', () => {
  it('read a plausible number of comment pointers', () => {
    // Both halves: a regex that stopped matching would report every pointer
    // as resolving, which is the same shape as a clean tree.
    const tracked = trackedFiles()
    expect(tracked.length).toBeGreaterThan(1000)
    expect(UNRESOLVED.length).toBeLessThan(40)
  })

  it('has no pointer at a file that is gone', () => {
    const stale = UNRESOLVED.filter((pointer) => !(pointer.key in DELIBERATE)).map(
      (pointer) => `${pointer.file}: \`${pointer.name}\` resolves to nothing`,
    )

    expect(stale).toEqual([])
  })

  it('holds no exemption for a pointer that now resolves', () => {
    const live = new Set(UNRESOLVED.map((pointer) => pointer.key))
    const obsolete = Object.keys(DELIBERATE).filter((key) => !live.has(key))

    expect(obsolete).toEqual([])
  })
})
