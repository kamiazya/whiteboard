/**
 * The snapshot chunk size is written in ONE place, and this scan is the
 * executable half of that.
 *
 * Why it needs a scan rather than a reader. `document-store.ts`'s own
 * comment already stated the coupling — "it must match across every writer
 * of these rows so a snapshot chunked by one path reassembles identically
 * when read by another" — and the number was nonetheless declared EIGHT
 * times under four different names, in five packages. Prose naming an
 * invariant is not the same as something that fails when the invariant
 * breaks, and the failure mode here is the quiet kind: a writer using a
 * different value produces rows that `reassembleSnapshot` refuses only when
 * some OTHER path reads them.
 *
 * What the rule is NOT. `packages/ports`'s own rule forbids baking an
 * implementation's cap into `chunkSnapshot`, which still takes
 * `maxChunkBytes` as a required parameter, and the stored manifest persists
 * the value each document was written with. So a backend with a smaller
 * message limit — the Cloudflare Durable Objects cap the ports rule names —
 * declares and passes its own, and this scan is about the writers of the
 * EXISTING planes agreeing with each other, never about capping the helper.
 *
 * Four declarations are allowlisted, in three kinds, and none of them is a
 * writer that picked its own production value.
 *
 * Two are frozen historical values rather than debt: a migration's numbers
 * are the ones it RAN with, and reading a live constant would retroactively
 * change what an already-migrated record claims about itself, which
 * `browser-idb-upgrades.ts` says at its own declaration. One is a
 * deliberate INVALID value, `writeUnreadableRecord`'s `-1`, so the
 * conformance suite can put a store into the state its own reader refuses.
 * One is deliberately TINY, the conformance suite's own 4 bytes, because at
 * the production value every fixture would be a single chunk and the
 * reassembly paths the suite exists to exercise would never run.
 *
 * They stay in the allowlist rather than being excluded by the pattern,
 * because an exemption is a classification: the next hardcoded manifest
 * value has to say which of these it is. The fourth was found by widening
 * this scan rather than by reading, which is the argument for the width.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stripCommentsAndStrings, walkSourceFiles } from './source-scan.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

/** Every package that writes or reads a chunked snapshot row. */
const SCAN_DIRS = [
  'apps/web/src',
  'packages/ports/src',
  'packages/server-core/src',
  'packages/workspace-index/src',
  'packages/mcp-server/src',
]

/** Where the one declaration lives. Exempt by construction: it IS the place. */
const DECLARATION_SITE = 'packages/ports/src/snapshot.ts'

/**
 * A chunk size DECLARED as a literal: a binding whose name ends in
 * `CHUNK_BYTES` assigned a number, or the manifest field itself given a
 * literal. `maxChunkBytes: someConstant` and a parameter named
 * `maxChunkBytes` are both hand-overs, not declarations, and do not match.
 */
const DECLARATION = /(?:[A-Z_]*CHUNK_BYTES|maxChunkBytes)\s*[:=]\s*-?\d[\d_]*/

/**
 * Files allowed to declare their own, each with the reason. Both are frozen
 * historical values; see this file's header. Length pinned so a third entry
 * is a decision visible in the diff.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {
  'packages/mcp-server/src/server/store/db/migrations/0011-import-fs-blobs.ts':
    'a migration replays with the value it originally wrote; its own comment says so',
  'apps/web/src/lib/browser-idb-upgrades.ts':
    'the same reason one level out: an already-migrated record must keep claiming the value it was migrated with',
  'packages/mcp-server/src/server/store/libsql/libsql-document-store.ts':
    'writeUnreadableRecord stores -1 on purpose, an invalid value the conformance seam needs so a reader can be shown refusing it',
  'packages/ports/src/test-utils/document-store-conformance.ts':
    'the conformance suite chunks at 4 bytes deliberately; at the production value every fixture would be one chunk and reassembly would never run',
}

/**
 * Deliberately NOT `isTestPath`, which excludes any `test-utils` segment.
 * `server-core`'s `FakeDocumentStore` lives there, writes these rows
 * through `chunkSnapshot`, and is what the DocumentStore conformance suite
 * runs against — a double that chunks differently from production makes the
 * suite agree about the wrong thing, which is the one failure a conformance
 * suite cannot report. So a published test UTILITY is in scope; an
 * individual test file is not.
 */
const files: string[] = []
for (const dir of SCAN_DIRS) walkSourceFiles(join(REPO_ROOT, dir), files)
const production = files.filter((path) => !/\.(test|spec)\.tsx?$/.test(path))

/** What the pattern must catch, and what it must let through. */
const FIXTURES: readonly { readonly source: string; readonly declares: boolean }[] = [
  { source: 'const SNAPSHOT_MAX_CHUNK_BYTES = 1_000_000', declares: true },
  { source: 'const MAX_CHUNK_BYTES = 1000000', declares: true },
  { source: 'const LEGACY_MAX_CHUNK_BYTES = 1_000_000', declares: true },
  { source: 'manifest = { maxChunkBytes: 1_000_000, chunkCount: 1 }', declares: true },
  // The poison value a conformance seam writes is still a declaration: a
  // store that hardcodes one has to say so here.
  { source: 'await trx.values({ maxChunkBytes: -1 })', declares: true },
  { source: 'chunkSnapshot(bytes, DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES)', declares: false },
  { source: 'const { maxChunkBytes } = manifest', declares: false },
  { source: 'function chunkSnapshot(bytes: Uint8Array, maxChunkBytes: number)', declares: false },
  { source: 'maxChunkBytes: manifest.maxChunkBytes', declares: false },
  { source: 'maxChunkBytes: opts.maxChunkBytes ?? fallback', declares: false },
  { source: '// maxChunkBytes: 1_000_000 in prose about the old value', declares: false },
  { source: "const s = 'maxChunkBytes: 1_000_000'", declares: false },
]

describe('the snapshot chunk size is written in one place', () => {
  it('recognises a literal declaration and passes a hand-over through', () => {
    for (const { source, declares } of FIXTURES) {
      const stripped = stripCommentsAndStrings(source)
      expect(DECLARATION.test(stripped), source).toBe(declares)
    }
  })

  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(production.length).toBeGreaterThan(300)
  })

  it('no writer outside ports declares its own chunk size', () => {
    const hits: string[] = []
    for (const path of production) {
      const rel = relative(REPO_ROOT, path).split(sep).join('/')
      if (rel === DECLARATION_SITE) continue
      if (ALLOWLIST[rel] !== undefined) continue
      const source = stripCommentsAndStrings(readFileSync(path, 'utf8'))
      const match = DECLARATION.exec(source)
      if (match !== null) hits.push(`${rel}: ${match[0].trim()}`)
    }
    expect(hits).toEqual([])
  })

  it('every allowlisted file exists and really declares one', () => {
    // An allowlist entry that has stopped being true is an exemption for
    // nothing, and it reads exactly like a rule being kept.
    for (const [rel, reason] of Object.entries(ALLOWLIST)) {
      const source = stripCommentsAndStrings(readFileSync(join(REPO_ROOT, rel), 'utf8'))
      expect(DECLARATION.test(source), `${rel} no longer declares a chunk size`).toBe(true)
      expect(reason.split(/\s+/).length, `${rel}'s reason is too short to be one`).toBeGreaterThan(
        8,
      )
    }
  })

  it('the allowlist holds exactly the four classified declarations', () => {
    expect(Object.keys(ALLOWLIST)).toHaveLength(4)
  })
})
