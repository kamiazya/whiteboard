/**
 * server-core HAS a logger: `log.ts` is an injectable seam the composition
 * root forwards into pino (`mcp-server`'s `server-core-logs.ts`), and
 * production files there call `getLogger`. Comments kept saying otherwise —
 * "a shared layer with no logger", "server-core has no logger of its own" —
 * and each one justified swallowing a failure in silence, so the false
 * premise carried a real cost: the failure it excused went unrecorded.
 *
 * A phrase list rather than a reader, like `comment-chronology-phrases`: the
 * claim is short and always spelled the same way. What counts as a comment is
 * the parser's answer (`stripComments`), so a claim trailing code on its line
 * (`} catch {} // server-core has no logger`) is read like one standing alone,
 * and a string that happens to hold `//` is not. Scoped to the two trees
 * that run with a logger to hand, so the true sentence about a package that
 * has none (canvas-render, whose degradations reach the caller through
 * `onDegrade`) is a recorded exemption that must keep saying it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { stripComments } from './strip-comments.js'
import { trackedFiles } from './tracked-files.js'

const NO_LOGGER = /\bno logger\b/i

const isScanned = (path: string): boolean =>
  /\.(?:tsx?|mts)$/.test(path) &&
  (path.startsWith('packages/server-core/src/') ||
    path.startsWith('packages/mcp-server/src/server/'))

/** Comment lines that say it about a package that truly has none. Keyed by file. */
const TRUE_OF_ANOTHER_PACKAGE: Readonly<Record<string, string>> = {
  'packages/mcp-server/src/server/export/headless-renderer.degradation.test.ts':
    'says canvas-render has no logger, which is true: its degradations reach the caller through onDegrade',
}

/**
 * The comment text on each line: the span `stripComments` blanked, from its
 * first changed character to its last. Offsets survive the strip, so line `i`
 * of one is line `i` of the other.
 */
function commentLines(text: string, fileName: string): string[] {
  const stripped = stripComments(text, fileName).split('\n')
  return text.split('\n').map((line, index) => {
    const bare = stripped[index] ?? line
    let first = 0
    while (first < line.length && line[first] === bare[first]) first += 1
    let last = line.length - 1
    while (last >= first && line[last] === bare[last]) last -= 1
    return line.slice(first, last + 1)
  })
}

function claimsIn(text: string, fileName = 'fixture.ts'): number[] {
  if (!NO_LOGGER.test(text)) return []
  return commentLines(text, fileName).flatMap((comment, index) =>
    NO_LOGGER.test(comment) ? [index + 1] : [],
  )
}

const files = trackedFiles(REPO_ROOT).filter(isScanned)
const found = files.flatMap((file) =>
  claimsIn(readFileSync(join(REPO_ROOT, file), 'utf8'), file).map((line) => ({ file, line })),
)

describe('no comment in a tree with a logger claims it has none', () => {
  it('recognises the claim in a comment and not in code', () => {
    expect(
      claimsIn('  // server-core is a shared\n  // layer with no logger to report it'),
    ).toEqual([2])
    expect(claimsIn('/**\n * reports rather than logs (server-core has no logger).\n */')).toEqual([
      2,
    ])
    expect(claimsIn("const msg = 'no logger configured'")).toEqual([])
    expect(claimsIn('  // logged as a warning rather than lost')).toEqual([])
    expect(claimsIn('try { run() } catch {} // server-core has no logger, so swallow')).toEqual([1])
    expect(claimsIn('run() /* no logger here */ + 1')).toEqual([1])
    expect(claimsIn("const hint = 'see https://x.example // no logger'")).toEqual([])
    expect(claimsIn('const re = /no logger/ // matched in messages')).toEqual([])
  })

  it('scans both trees, the files that once said it among them', () => {
    expect(files.length).toBeGreaterThan(500)
    expect(files).toEqual(
      expect.arrayContaining([
        'packages/server-core/src/document-io.ts',
        'packages/server-core/src/tools/canvas-edit.ts',
        'packages/mcp-server/src/server/routes/document/workspaces.ts',
      ]),
    )
  })

  it('finds the claim nowhere but the recorded exemptions', () => {
    const hits = found
      .filter(({ file }) => !(file in TRUE_OF_ANOTHER_PACKAGE))
      .map(({ file, line }) => `${file}:${line}`)
    expect(hits).toEqual([])
  })

  it('holds no exemption for a file that no longer says it', () => {
    const live = new Set(found.map(({ file }) => file))
    expect(Object.keys(TRUE_OF_ANOTHER_PACKAGE).filter((file) => !live.has(file))).toEqual([])
  })
})
