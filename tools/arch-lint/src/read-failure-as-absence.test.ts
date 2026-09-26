/**
 * A file read whose failure is answered as an absence must be CLASSIFIED —
 * the executable half of "only ENOENT means there is nothing here".
 *
 * Why it exists: the daemon identity and the macaroon root key were both read
 * as `try { readFileSync } catch { return null }`, and their caller answers
 * `null` by minting a new secret and writing it over the path. A secret that
 * was merely unreadable was therefore REPLACED — a new daemon identity is
 * indistinguishable, to every client that pinned the old, from someone else
 * answering. Both now go through `readSecretFileIfPresentSync`, which answers
 * `null` on ENOENT only.
 *
 * A new site of that shape fails here until it either checks ENOENT or is
 * entered below with what its caller does on the answer. Every entry is a
 * DECISION, in one of five words, and a bare word is refused:
 *
 * - `probe:` nothing acts on the answer beyond not knowing something;
 * - `fails-safe:` the caller's action on the absence is the conservative one;
 * - `degrades-visibly:` the absence shows, so nobody is misled by it;
 * - `deliberate:` a trade-off that is written down where the read is;
 * - `debt:` it is wrong, what goes wrong, and what would fix it.
 *
 * Guarded from both sides, like every allowlist in this tool: an entry that
 * no longer matches a site fails too, so the ledger cannot outlive the reads
 * it classifies.
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findReadFailuresAsAbsence } from './read-failure-as-absence.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

const VOCABULARY = /^(probe|fails-safe|degrades-visibly|deliberate|debt): (\S+\s+){7,}\S+/

const LEDGER: Readonly<Record<string, string>> = {
  'packages/mcp-server/src/daemon/container-detection.ts#defaultReadCgroup':
    'probe: reads /proc/1/cgroup to guess whether this runs in a container, and an unreadable file only means it cannot tell',
  'packages/mcp-server/src/shared/mkdir-lock.ts#loadOwnerMetadata':
    'fails-safe: an owner it cannot read is never judged dead, so the lock is waited on rather than broken',
  'packages/mcp-server/src/server/server-mode-web-app.ts#mountServerModeWebApp':
    'degrades-visibly: a shell it cannot read serves the placeholder page, which says the app is missing rather than pretending',
  'packages/mcp-server/src/server/store/db/location-record.ts#readDatabaseLocationRecord':
    'deliberate: backup falls back to the environment and restore to its file-presence check, and restore refuses a mismatch either way',
  'packages/mcp-server/src/server/store/db/migrations/0011-import-fs-blobs.ts#importOneBlob':
    'deliberate: logs a warning and skips the one blob, leaving its source file in place, and nothing deletes it afterwards',
  'packages/mcp-server/src/server/store/backup-in-progress.ts#backupIsInProgress':
    'deliberate: fails open so a stale marker cannot stop GC for ever, at the cost the file-gc stand-down comment names for a backup running meanwhile',
  'packages/mcp-server/src/server/store/backup-blob-mirror.ts#readBackupBlobManifest':
    'debt: retention fails safe on it, but restore reads an unreadable manifest as a pre-mirror backup and copies the mirror stores into the data directory — an unreadable manifest should refuse the restore',
  'packages/mcp-server/src/daemon/daemon-registry.ts#loadDaemonRecord':
    'debt: ensure-daemon reads an unreadable record as no daemon and starts a second one whose record overwrites the first — only ENOENT should mean none is running',
  'packages/mcp-server/src/server/security/server-mode-record.ts#readServerModeRecord':
    "debt: an unreadable record reads as missing, so `server stop` reports not-running and exits 0 while a server may run — it needs an 'unreadable' kind",
}

function scan(): {
  readonly sites: ReturnType<typeof findReadFailuresAsAbsence>
  readonly files: number
} {
  const sites: ReturnType<typeof findReadFailuresAsAbsence> = []
  let files = 0
  for (const absolute of walkSourceFiles(join(REPO_ROOT, 'packages'))) {
    const path = relative(REPO_ROOT, absolute)
    if (!/\/src\//.test(path) || isTestPath(path)) continue
    files += 1
    sites.push(...findReadFailuresAsAbsence(path, readFileSync(absolute, 'utf8')))
  }
  return { sites, files }
}

describe('a file read whose failure is answered as an absence', () => {
  const { sites, files } = scan()

  it('scans the production source it claims to', () => {
    // A walk that stopped finding files would report every entry as stale,
    // which sends a reader to the wrong question entirely.
    expect(files).toBeGreaterThan(300)
  })

  it('is classified when it does not check ENOENT', () => {
    const unclassified = sites
      .filter((site) => !(site.key in LEDGER))
      .map(
        (site) =>
          `${site.key} (line ${site.line}) answers ${site.answer} for ANY read failure. Only ENOENT means absent: check \`err.code === 'ENOENT'\` and re-throw the rest (for a secret, use readSecretFileIfPresentSync), or classify it in LEDGER with what its caller does on that answer.`,
      )
    expect(unclassified).toEqual([])
  })

  it('names only sites that still exist', () => {
    const found = new Set(sites.map((site) => site.key))
    expect(Object.keys(LEDGER).filter((key) => !found.has(key))).toEqual([])
  })

  it('gives every entry a decision and a reason, not a word', () => {
    expect(Object.entries(LEDGER).filter(([, reason]) => !VOCABULARY.test(reason))).toEqual([])
  })
})

describe('what the scan sees', () => {
  const found = (source: string) =>
    findReadFailuresAsAbsence('fixture.ts', source).map((s) => s.answer)

  it('flags the shape that replaced the daemon identity', () => {
    expect(
      found(
        `function tryLoad(p) { let raw; try { raw = readFileSync(p, 'utf8') } catch { return null } return raw }`,
      ),
    ).toEqual(['null'])
  })

  it('flags a promise read answered as an absence', () => {
    expect(found(`const shell = await readFile(p, 'utf-8').catch(() => null)`)).toEqual(['null'])
  })

  it('passes a read that asks whether the file was absent', () => {
    expect(
      found(
        `function f(p) { try { return readFileSync(p, 'utf8') } catch (err) { if (err.code === 'ENOENT') return null; throw err } }`,
      ),
    ).toEqual([])
  })

  it('passes a catch that does not answer an absence', () => {
    expect(
      found(
        `function f(p) { try { return readFileSync(p) } catch (err) { throw new Error('x', { cause: err }) } }`,
      ),
    ).toEqual([])
  })
})
