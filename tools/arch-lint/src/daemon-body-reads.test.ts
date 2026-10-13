/**
 * A daemon answer's body is read in ONE place: daemon-client's
 * `readJsonOrUndefined` (`api-contracts/read-body.ts`). The web app's
 * `readDaemonJson` and daemon-client's `refusalReasonOf` and
 * `requestReplicaKey` all read through it. That is where a body cut
 * mid-stream becomes the network's failure and a body that arrived and is not
 * JSON becomes `undefined` for the caller's contract to report as drift. A
 * client calling `res.json()` itself decides both again, and differently: a
 * `SyntaxError` escaping untyped, a `.catch(() => null)` that swallows the
 * drift with no record, a cut body read as a malformed one.
 *
 * It reads shipped `apps/web/src` and `packages/daemon-client/src` with
 * comments removed and fails on any `.json()` or `.text()` call outside the
 * home. The pattern cannot tell a daemon `Response` from a `File`, so a body
 * that is not a daemon answer is ledgered with what it reads — honestly
 * classified, never assumed. A binary answer (`arrayBuffer()`) has no
 * drift arm to decide, so the pattern does not read it.
 *
 * The ledger is guarded from both sides like every allowlist here: an entry
 * pins the exact number of reads in its file, so one more fails as a new read
 * and one fewer fails as stale.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { isShippedPath, walkSourceFiles } from './source-scan.js'
import { stripComments } from './strip-comments.js'

/** The one module that reads a daemon answer's body; apps/web's `readDaemonJson` reads through it. */
const HOME = 'packages/daemon-client/src/api-contracts/read-body.ts'

/** The scanned trees, each with a floor its walk must clear. */
const TREES = [
  { root: 'apps/web/src', minFiles: 300 },
  { root: 'packages/daemon-client/src', minFiles: 20 },
] as const

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
]

/** A body read: `.json()` or `.text()`, however it is spaced. */
const BODY_READ = /\.(?:json|text)\(\s*\)/g

function bodyReads(source: string): number {
  return [...stripComments(source).matchAll(BODY_READ)].length
}

const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')

function countsUnder(root: string): Map<string, number> {
  return new Map(
    walkSourceFiles(join(REPO_ROOT, root))
      .filter((path) => isShippedPath(path))
      .map(relOf)
      .map((file) => [file, bodyReads(readFileSync(join(REPO_ROOT, file), 'utf8'))] as const),
  )
}

const countsByRoot = new Map(TREES.map((tree) => [tree.root, countsUnder(tree.root)] as const))
const counts = new Map([...countsByRoot.values()].flatMap((perRoot) => [...perRoot]))

/** Files outside the home and the ledger that read a body, as `file: reads`. */
function offendersIn(scanned: ReadonlyMap<string, number>): string[] {
  return [...scanned]
    .filter(([file, reads]) => reads > 0 && file !== HOME)
    .filter(([file]) => !LEDGER.some((entry) => entry.file === file))
    .map(([file, reads]) => `${file}: ${reads}`)
}

describe('a daemon answer is read through the one body reader', () => {
  it.each(TREES)('scans shipped $root', (tree) => {
    // A count far below the tree's size means the walk missed it, not that
    // the tree stopped reading bodies.
    expect(countsByRoot.get(tree.root)?.size ?? 0).toBeGreaterThan(tree.minFiles)
  })

  it('finds the home it holds the reads to', () => {
    expect(counts.get(HOME) ?? 0).toBeGreaterThan(0)
  })

  it('no shipped module outside the home reads a response body itself', () => {
    expect(
      offendersIn(counts),
      'read a daemon answer with readDaemonJson (apps/web) or readJsonOrUndefined (daemon-client, api-contracts/read-body.ts), a refusal with refusalReasonOf; ledger a body that is not a daemon answer with what it reads',
    ).toEqual([])
  })

  it('names a read planted in daemon-client outside its home', () => {
    const planted = new Map([
      [HOME, 1],
      ['packages/daemon-client/src/sse-stream-hub.ts', bodyReads('await res.json()')],
    ])
    expect(offendersIn(planted)).toEqual(['packages/daemon-client/src/sse-stream-hub.ts: 1'])
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
