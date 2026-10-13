/**
 * The web app reads a daemon answer's body in ONE place: `readDaemonJson`
 * (`apps/web/src/lib/daemon-contract-error.ts`). That is where a body cut
 * mid-stream becomes the network's failure, a body that arrived and is not JSON
 * becomes contract drift, and drift is logged once with its route. A client
 * calling `res.json()` itself decides all three again, and differently: a
 * `SyntaxError` escaping untyped, a `.catch(() => null)` that swallows the
 * drift with no record, a cut body read as a malformed one.
 *
 * It reads shipped `apps/web/src` with comments removed and fails on any
 * `.json()` or `.text()` call outside the home. The pattern cannot tell a
 * daemon `Response` from a `File`, so a body that is not a daemon answer is
 * ledgered with what it reads — honestly classified, never assumed.
 *
 * The ledger is guarded from both sides like every allowlist here: an entry
 * pins the exact number of reads in its file, so one more fails as a new read
 * and one fewer fails as stale. A refusal body is read by daemon-client's
 * `refusalReasonOf`, which lives outside this tree and is the refusal reader.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { isShippedPath, walkSourceFiles } from './source-scan.js'
import { stripComments } from './strip-comments.js'

const WEB_ROOT = 'apps/web/src'

/** Where a daemon answer's body is read. */
const HOME = 'apps/web/src/lib/daemon-contract-error.ts'

interface Exemption {
  readonly file: string
  /** How many `.json()`/`.text()` calls the file holds, exactly. */
  readonly reads: number
  readonly why: string
}

const LEDGER: readonly Exemption[] = [
  {
    file: 'apps/web/src/lib/render-store.ts',
    reads: 1,
    why: 'not a daemon answer: `File.text()` on a cached render this browser wrote to its own storage',
  },
  {
    file: 'apps/web/src/pages/ServerModeApp.tsx',
    reads: 3,
    why: 'debt: the server-mode session and sign-in providers answers, parsed with parseDaemonResponse over a bare `res.json()`, so a non-JSON body escapes as an untyped SyntaxError; belongs on readDaemonJson',
  },
]

/** A body read: `.json()` or `.text()`, however it is spaced. */
const BODY_READ = /\.(?:json|text)\(\s*\)/g

function bodyReads(source: string): number {
  return [...stripComments(source).matchAll(BODY_READ)].length
}

const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')

const counts = new Map(
  walkSourceFiles(join(REPO_ROOT, WEB_ROOT))
    .filter((path) => isShippedPath(path))
    .map(relOf)
    .map((file) => [file, bodyReads(readFileSync(join(REPO_ROOT, file), 'utf8'))] as const),
)

const reading = [...counts].filter(([, reads]) => reads > 0)

describe('the web app reads a daemon answer through readDaemonJson', () => {
  it('scans the shipped web tree and finds the home it holds the reads to', () => {
    // A count far below the tree's size means the walk missed it, not that
    // the web app stopped reading bodies.
    expect(counts.size).toBeGreaterThan(300)
    expect(counts.get(HOME) ?? 0).toBeGreaterThan(0)
  })

  it('no shipped web module reads a response body itself', () => {
    const offenders = reading
      .filter(([file]) => file !== HOME && !LEDGER.some((entry) => entry.file === file))
      .map(([file, reads]) => `${file}: ${reads}`)
    expect(
      offenders,
      'read a daemon answer with readDaemonJson (apps/web/src/lib/daemon-contract-error.ts), a refusal with refusalReasonOf; ledger a body that is not a daemon answer with what it reads',
    ).toEqual([])
  })

  it('every ledger entry holds exactly the reads it names', () => {
    const drifted = LEDGER.filter((entry) => counts.get(entry.file) !== entry.reads).map(
      (entry) => `${entry.file}: ledgered ${entry.reads}, found ${counts.get(entry.file) ?? 0}`,
    )
    expect(drifted).toEqual([])
  })

  it('reads a body call however it is chained or spaced', () => {
    expect(bodyReads('schema.parse(await res.json())')).toBe(1)
    expect(bodyReads('await res.json().catch(() => null)')).toBe(1)
    expect(bodyReads('await (await fetchFn(url)).json()')).toBe(1)
    expect(bodyReads('reach(res.text( ))')).toBe(1)
  })

  it('does not read a comment, a property, or a JSON namespace call as a body read', () => {
    expect(bodyReads('// await res.json()\nconst x = 1')).toBe(0)
    expect(bodyReads('/** `res.text()` is the home */\nconst x = 1')).toBe(0)
    expect(bodyReads('const t = res.text; JSON.parse(s); x.jsonValue()')).toBe(0)
  })
})
