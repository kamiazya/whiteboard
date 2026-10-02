/**
 * A blob's identity is spelled in ONE place per runtime, and this scan is the
 * executable half of that.
 *
 * Two things carry it. The in-memory and IndexedDB key of a `BlobRef` is
 * `blobRefKey` in `ports`, for the reason `docRefKey` lives there. Where a
 * digest sits on disk — the two-hex shard, the sixty-two-hex remainder, the
 * regexes that recognise each — is `tenant/data-layout.ts`'s `blobShardPath`
 * and `parseBlobShard`, because the live store, the backup mirror, its
 * retention and the restore must agree byte for byte, and a sharding change
 * made in one of them is a restore that copies from a path the live store no
 * longer reads. Nothing fails until somebody restores.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isExcludedPath, REPO_ROOT, relativeToRepo, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const REF_KEY_SITE = 'packages/ports/src/blob-ref-key.ts'
const SHARD_SITE = 'packages/mcp-server/src/server/tenant/data-layout.ts'
/** The `BlobRef` contract itself: the one place the digest's shape is declared. */
const DIGEST_SCHEMA_SITE = 'packages/ports/src/blob-store.ts'
const SHA256_SITE = 'packages/mcp-server/src/shared/sha256.ts'

/** `${ref.algorithm}:${ref.digestHex}`, whatever the receiver is called. */
const REF_KEY_SPELLING = /\$\{[^}]*algorithm\}:\$\{[^}]*digestHex\}/g
/** A digest cut into shard and remainder by hand: `digest.slice(0, 2)`, `digestHex.slice(2)`. */
const DIGEST_SLICE = /[dD]igest\w*\s*\.slice\(\s*(?:0\s*,\s*)?2\s*\)/g
/** The shape of a digest or of its halves, as a regex literal. */
const DIGEST_SHAPE = /\[0-9a-f\]\{(?:2|62|64)\}/g
/** A sha-256 hex digest computed inline rather than through `sha256Hex`. */
const INLINE_SHA256_HEX =
  /createHash\(\s*['"]sha256['"]\s*\)\s*\.update\([^)]*\)\s*\.digest\(\s*['"]hex['"]\s*\)/g

function code(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

function count(pattern: RegExp, source: string): number {
  return code(source).match(pattern)?.length ?? 0
}

const files = SCAN_ROOTS.flatMap((root) => walkSourceFiles(join(REPO_ROOT, root))).filter(
  (path) => !isExcludedPath(path),
)
// Tests are left out of the layout rules on purpose: a test that spells where a
// blob must land is the independent oracle for `blobShardPath`, and routing it
// through that function would make it agree with whatever the function does.
const mcpFiles = files.filter(
  (path) => relativeToRepo(path).startsWith('packages/mcp-server/src/') && !isTestPath(path),
)

function offenders(
  among: readonly string[],
  pattern: RegExp,
  exempt: readonly string[],
  allowlist: Readonly<Record<string, number>> = {},
): string[] {
  const hits: string[] = []
  for (const path of among) {
    const rel = relativeToRepo(path)
    if (exempt.includes(rel)) continue
    const found = count(pattern, readFileSync(path, 'utf8'))
    if (found > (allowlist[rel] ?? 0)) hits.push(`${rel}: ${found}`)
  }
  return hits
}

// Joined rather than written, so the fixtures hold a real placeholder without
// the linter reading each as a template that forgot its backticks.
const HOLE = ['$', '{x}'].join('')

describe('a blob key and a blob path are spelled in one place', () => {
  it('recognises each spelling and passes prose and neighbours through', () => {
    expect(
      count(
        REF_KEY_SPELLING,
        `const k = \`${HOLE.replace('x', 'ref.algorithm')}:${HOLE.replace('x', 'ref.digestHex')}\``,
      ),
    ).toBe(1)
    expect(
      count(REF_KEY_SPELLING, `const k = \`${HOLE.replace('x', 'a')}:${HOLE.replace('x', 'b')}\``),
    ).toBe(0)
    expect(count(DIGEST_SLICE, 'const a = digest.slice(0, 2)')).toBe(1)
    expect(count(DIGEST_SLICE, 'const a = ref.digestHex.slice(2)')).toBe(1)
    expect(count(DIGEST_SLICE, 'const a = digest.slice(0, 16)')).toBe(0)
    expect(count(DIGEST_SLICE, 'const a = line.slice(2)')).toBe(0)
    expect(count(DIGEST_SHAPE, 'const R = /^[0-9a-f]{62}$/')).toBe(1)
    expect(count(DIGEST_SHAPE, '// /^[0-9a-f]{62}$/ in prose')).toBe(0)
    expect(count(INLINE_SHA256_HEX, "createHash('sha256').update(bytes).digest('hex')")).toBe(1)
    expect(count(INLINE_SHA256_HEX, "createHash('sha256').update(v).digest('base64url')")).toBe(0)
  })

  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(files.length).toBeGreaterThan(800)
    expect(mcpFiles.length).toBeGreaterThan(200)
  })

  it('the declaration sites still hold what the rules say they hold', () => {
    const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')
    expect(count(REF_KEY_SPELLING, read(REF_KEY_SITE))).toBe(1)
    expect(read(SHARD_SITE)).toContain('export function blobShardPath(')
    expect(count(DIGEST_SHAPE, read(SHARD_SITE))).toBe(2)
    expect(count(DIGEST_SHAPE, read(DIGEST_SCHEMA_SITE))).toBe(1)
    expect(count(INLINE_SHA256_HEX, read(SHA256_SITE))).toBe(1)
  })

  it('no file outside ports spells the ref key', () => {
    expect(offenders(files, REF_KEY_SPELLING, [REF_KEY_SITE])).toEqual([])
  })

  it('no file outside data-layout cuts a digest into shard and remainder', () => {
    expect(offenders(mcpFiles, DIGEST_SLICE, [SHARD_SITE])).toEqual([])
  })

  it('no file outside data-layout and the BlobRef schema restates the digest shape', () => {
    expect(offenders(mcpFiles, DIGEST_SHAPE, [SHARD_SITE, DIGEST_SCHEMA_SITE])).toEqual([])
  })

  it('no mcp-server file hashes with sha-256 to hex inline', () => {
    expect(offenders(mcpFiles, INLINE_SHA256_HEX, [SHA256_SITE])).toEqual([])
  })
})
