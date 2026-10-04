/**
 * server-core HAS a logger: `log.ts` is an injectable seam the composition
 * root forwards into pino (`mcp-server`'s `server-core-logs.ts`), and
 * production files there call `getLogger`. Comments kept saying otherwise —
 * "a shared layer with no logger", "server-core has no logger of its own" —
 * and each one justified swallowing a failure in silence, so the false
 * premise carried a real cost: the failure it excused went unrecorded.
 *
 * A phrase list rather than a reader, like `comment-chronology-phrases`: the
 * claim is short and always spelled the same way. Scoped to the two trees
 * that run with a logger to hand, so the true sentence about a package that
 * has none (canvas-render, whose degradations reach the caller through
 * `onDegrade`) is a recorded exemption that must keep saying it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { trackedFiles } from './tracked-files.js'

const NO_LOGGER = /\bno logger\b/i

const isScanned = (path: string): boolean =>
  /\.(?:tsx?|mts)$/.test(path) &&
  (path.startsWith('packages/server-core/src/') ||
    path.startsWith('packages/mcp-server/src/server/'))

const isComment = (line: string): boolean => /^\s*(?:\/\/|\*|\/\*)/.test(line)

/** Comment lines that say it about a package that truly has none. Keyed by file. */
const TRUE_OF_ANOTHER_PACKAGE: Readonly<Record<string, string>> = {
  'packages/mcp-server/src/server/export/headless-renderer.degradation.test.ts':
    'says canvas-render has no logger, which is true: its degradations reach the caller through onDegrade',
}

const claimsIn = (text: string): number[] =>
  text
    .split('\n')
    .flatMap((line, index) => (isComment(line) && NO_LOGGER.test(line) ? [index + 1] : []))

const files = trackedFiles(REPO_ROOT).filter(isScanned)
const found = files.flatMap((file) =>
  claimsIn(readFileSync(join(REPO_ROOT, file), 'utf8')).map((line) => ({ file, line })),
)

describe('no comment in a tree with a logger claims it has none', () => {
  it('recognises the claim in a comment and not in code', () => {
    expect(
      claimsIn('  // server-core is a shared\n  // layer with no logger to report it'),
    ).toEqual([2])
    expect(claimsIn(' * reports rather than logs (server-core has no logger).')).toEqual([1])
    expect(claimsIn("const msg = 'no logger configured'")).toEqual([])
    expect(claimsIn('  // logged as a warning rather than lost')).toEqual([])
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
