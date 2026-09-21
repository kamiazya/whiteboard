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
 * A chunk size DECLARED as a literal, in the three spellings it can take: a
 * binding whose name ends in `CHUNK_BYTES` assigned a number, the manifest
 * field itself given one, or a literal passed straight to `chunkSnapshot`.
 *
 * The third was missing when this scan was written, and it is the one a
 * writer in a hurry reaches for: `chunkSnapshot(bytes, 1_000_000)` declares
 * a chunk size as surely as a `const` does.
 * `background-work-costs.test.ts` had already learned this exact lesson one
 * level out — its third test exists because a worker could declare its
 * ceiling INLINE and pass a scan that only read the central map. This
 * file's header cites that precedent and the first version still had the
 * hole, which is the part worth recording.
 *
 * `maxChunkBytes: someConstant`, a parameter named `maxChunkBytes`, and
 * `chunkSnapshot(bytes, SOME_CONSTANT)` are hand-overs, not declarations,
 * and do not match.
 */
const DECLARATION =
  /(?:[A-Z_]*CHUNK_BYTES|maxChunkBytes)\s*[:=]\s*-?\d[\d_]*|chunkSnapshot\s*\([^,()]*,\s*-?\d[\d_]*/

/**
 * Files allowed to declare their own, each pinned to the EXACT declaration
 * it is exempt for. See this file's header for the three kinds.
 *
 * Pinned to the TEXT rather than to the file, because membership alone is a
 * blanket: an allowlisted file could add a second, unrelated declaration and
 * the scan would skip the whole file. Measured — sneaking a
 * `const SNEAKED_CHUNK_BYTES = 777` into an allowlisted file left all five
 * tests green. `file-size-budget.test.ts` already knew this; its own comment
 * says its first version "recorded a count nothing compared against", and
 * 11 of 17 files grew under a green build.
 */
interface AllowedDeclaration {
  /**
   * The exact declarations this file is exempt for, with how many times the
   * source spells each. Counted rather than merely listed, because two of
   * these files write the same value more than once and a list would exempt
   * a third copy nobody looked at.
   */
  readonly declarations: readonly { readonly text: string; readonly times: number }[]
  readonly reason: string
}

const ALLOWLIST: Readonly<Record<string, AllowedDeclaration>> = {
  'packages/mcp-server/src/server/store/db/migrations/0011-import-fs-blobs.ts': {
    declarations: [{ text: 'const IMPORT_MAX_CHUNK_BYTES = 1_000_000', times: 1 }],
    reason: 'a migration replays with the value it originally wrote; its own comment says so',
  },
  'apps/web/src/lib/browser-idb-upgrades.ts': {
    declarations: [{ text: 'const LEGACY_MAX_CHUNK_BYTES = 1_000_000', times: 1 }],
    reason:
      'the same reason one level out: an already-migrated record must keep claiming the value it was migrated with',
  },
  'packages/mcp-server/src/server/store/libsql/libsql-document-store.ts': {
    // Twice: the insert and the `doUpdateSet` that has to write the same
    // poison value, or an upsert would leave a readable record behind.
    declarations: [{ text: 'maxChunkBytes: -1', times: 2 }],
    reason:
      'writeUnreadableRecord stores -1 on purpose, an invalid value the conformance seam needs so a reader can be shown refusing it',
  },
  'packages/ports/src/test-utils/document-store-conformance.ts': {
    // The default parameter once, and two manifest literals built from it.
    declarations: [
      { text: 'maxChunkBytes = 4', times: 1 },
      { text: 'maxChunkBytes: 4', times: 2 },
    ],
    reason:
      'the conformance suite chunks at 4 bytes deliberately; at the production value every fixture would be one chunk and reassembly would never run',
  },
}

/** How many times `text` appears in `source`. */
function occurrences(source: string, text: string): number {
  return source.split(text).length - 1
}

/**
 * The source with each allowed declaration removed exactly as many times as
 * the entry claims, so what remains is everything the file declares BEYOND
 * its exemption.
 */
function beyondTheExemption(source: string, allowed: AllowedDeclaration): string {
  let rest = source
  for (const { text, times } of allowed.declarations) {
    for (let i = 0; i < times; i += 1) {
      const at = rest.indexOf(text)
      if (at === -1) break
      rest = rest.slice(0, at) + rest.slice(at + text.length)
    }
  }
  return rest
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
  // The shape review found missing: a literal at the call site.
  { source: 'chunkSnapshot(bytes, 1_000_000)', declares: true },
  { source: 'chunkSnapshot(\n  snapshot,\n  4,\n)', declares: true },
  { source: 'chunkSnapshot(bytes, DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES)', declares: false },
  { source: 'chunkSnapshot(bytes, opts.maxChunkBytes)', declares: false },
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

  it('no writer outside ports declares its own chunk size, allowlisted files included', () => {
    const hits: string[] = []
    for (const path of production) {
      const rel = relative(REPO_ROOT, path).split(sep).join('/')
      if (rel === DECLARATION_SITE) continue
      const allowed = ALLOWLIST[rel]
      const whole = stripCommentsAndStrings(readFileSync(path, 'utf8'))
      // An exemption covers ONE declaration, so the rest of an allowlisted
      // file is scanned like anyone else's.
      const source = allowed === undefined ? whole : beyondTheExemption(whole, allowed)
      const match = DECLARATION.exec(source)
      if (match !== null) hits.push(`${rel}: ${match[0].trim()}`)
    }
    expect(hits).toEqual([])
  })

  it('every allowlisted file spells each exempt declaration exactly as many times as claimed', () => {
    // Guarded from both sides. An entry that has stopped being true is an
    // exemption for nothing and reads exactly like a rule being kept; an
    // entry claiming FEWER than the source has would exempt a copy nobody
    // classified, which is how the second `maxChunkBytes: -1` and the two
    // conformance literals were found.
    for (const [rel, allowed] of Object.entries(ALLOWLIST)) {
      const source = stripCommentsAndStrings(readFileSync(join(REPO_ROOT, rel), 'utf8'))
      for (const { text, times } of allowed.declarations) {
        expect(
          occurrences(source, text),
          `${rel} spells \`${text}\` a different number of times`,
        ).toBe(times)
      }
      expect(
        allowed.reason.split(/\s+/).length,
        `${rel}'s reason is too short to be one`,
      ).toBeGreaterThan(8)
    }
  })

  it('the allowlist holds exactly the four classified declarations', () => {
    expect(Object.keys(ALLOWLIST)).toHaveLength(4)
  })
})
