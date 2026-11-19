/**
 * A synchronous engine read ties its caller to an engine that runs in its own
 * realm.
 *
 * `CrdtEngine.readNow` answers at once, which only an engine that shares the
 * caller's memory can do: the TypeScript engine does, and a daemon or a worker
 * that answers over a message cannot. Each shipped call site outside
 * loro-adapter is therefore a place that would have to become asynchronous the
 * day the document moves out of process, and is listed in `SYNC_READ_CALLERS`
 * with the reason it cannot await. A caller that can await uses `read`.
 *
 * Both directions fail: a call site not listed is new, and a listed file that
 * no longer names it is stale. The host kit's `readNow(lease, ...)` is the same
 * call under another receiver and is found the same way.
 */
import { describe, expect, it } from 'vitest'
import { countNamedUses } from './named-use-scan.js'
import { readRepoSources } from './scan-roots.js'
import { isShippedPath } from './source-scan.js'

/** Shipped files outside loro-adapter that call `readNow`, each with why it cannot await. */
const SYNC_READ_CALLERS: Readonly<Record<string, string>> = {}

const SCANNED = /^(?:apps|packages)\/[^/]+\/src\//
const ADAPTER = 'packages/loro-adapter/src/'

/**
 * Whether the file names `readNow` anywhere code can reach it: a call, a method
 * taken as a value, an import under any alias, a bracket access. A bare reference
 * counts, since `.map(engine.readNow)` is the same dependence with no call to see.
 */
const namesReadNow = (path: string, text: string): boolean =>
  countNamedUses(path, text, ['readNow']) > 0

interface Scan {
  readonly files: number
  readonly callers: string[]
}

function scan(sources: ReadonlyArray<{ path: string; text: string }>): Scan {
  const files = sources.filter(
    ({ path }) => SCANNED.test(path) && !path.startsWith(ADAPTER) && isShippedPath(path),
  )
  const callers = files.filter(({ path, text }) => namesReadNow(path, text)).map(({ path }) => path)
  return { files: files.length, callers: callers.sort() }
}

const scanned = scan(readRepoSources())

describe('a synchronous engine read is a listed decision', () => {
  it('reaches the files it judges, so a clean scan is not a blind one', () => {
    expect(scanned.files).toBeGreaterThan(1000)
    const paths = readRepoSources().map(({ path }) => path)
    for (const tree of ['apps/web/src/', 'packages/server-core/src/', 'packages/mcp-server/src/']) {
      expect(paths.some((path) => path.startsWith(tree))).toBe(true)
    }
  })

  it('finds no call site that is not listed', () => {
    expect(scanned.callers.filter((path) => !(path in SYNC_READ_CALLERS))).toEqual([])
  })

  it('keeps no row whose file has stopped calling it', () => {
    const current = new Set(scanned.callers)
    expect(Object.keys(SYNC_READ_CALLERS).filter((path) => !current.has(path))).toEqual([])
  })

  it('gives every row the reason it cannot await', () => {
    for (const reason of Object.values(SYNC_READ_CALLERS)) expect(reason.length).toBeGreaterThan(20)
  })
})

describe('the scan reads every form of the call', () => {
  const found = (path: string, text: string) => scan([{ path, text }]).callers
  const at = 'apps/web/src/lib/a.ts'

  it.each([
    'engine.readNow({ handle, query })',
    'readNow(lease, query, shape)',
    'lease.engine.readNow(request)',
    'engine?.readNow(request)',
    'kit.readNow(lease, query, shape)',
    'const read = engine.readNow',
    "import { readNow } from 'x'\nreadNow(lease, query, shape)",
    "import { readNow as now } from 'x'\nnow(lease, query, shape)",
    "engine['readNow'](request)",
  ])('finds %s', (text) => {
    expect(found(at, text)).toEqual([at])
  })

  it('skips a comment, a string, a test, loro-adapter itself and a look-alike name', () => {
    expect(found(at, '// engine.readNow(request)')).toEqual([])
    expect(found(at, 'const text = "engine.readNow(request)"')).toEqual([])
    expect(found(at, 'engine.readNowAndThen(request)')).toEqual([])
    expect(found(at, "const name = 'readNow'")).toEqual([])
    expect(found('apps/web/src/lib/a.test.ts', 'engine.readNow(request)')).toEqual([])
    expect(found('packages/loro-adapter/src/a.ts', 'engine.readNow(request)')).toEqual([])
  })
})
