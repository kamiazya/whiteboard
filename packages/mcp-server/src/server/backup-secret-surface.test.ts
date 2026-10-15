/**
 * Every named file the daemon writes into its data directory, classified
 * against whether `backupDataDir` copies it.
 *
 * `backupDataDir` copies the data directory RECURSIVELY and excludes a
 * three-name list, so a file added later is copied by default — silently, and
 * into the one artifact `daemon-registry.ts` already describes as "the
 * opposite of owner-only … copied to another disk, shipped to support, kept
 * for months". That reasoning was written for the daemon token and never
 * extended, and the surface it guards has grown three files since.
 *
 * It was measured, not supposed: when this ledger was first written,
 * `macaroon-root-key.json` — the secret every act-plane token chains from,
 * added days earlier — was copied into every backup. Anyone holding a backup
 * could mint a macaroon with any scopes that verifies against the LIVE
 * daemon, because a restore does not rotate it.
 *
 * The ledger is over the data dir's own vocabulary rather than over "secrets",
 * because `NEVER_COPIED` is not the set of secrets. It is the set of files
 * whose presence in a backup is worse than their absence, and those are
 * different questions: the daemon token costs nothing to lose (it is minted
 * fresh at spawn) while the daemon's identity key costs every pinned client and
 * every past attestation. So each entry says which, and why.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { productionSourceFiles } from '../shared/test-utils/source-files.js'
import { NEVER_COPIED_FOR_TESTS } from './backup-restore.js'

const PACKAGE_SRC = fileURLToPath(new URL('..', import.meta.url))

type BackupDisposition =
  /** Excluded from a backup; the string says what losing it costs on restore. */
  | `never-copied: ${string}`
  /** Copied into a backup deliberately; the string says why that is safe. */
  | `copied: ${string}`
  /** Not a data-directory file at all; the string says where it does live. */
  | `not-in-data-dir: ${string}`

const BACKUP_DISPOSITION = {
  'daemon.json':
    'never-copied: the Bearer token granting full authority. Costs nothing to lose — a client mints a fresh one and spawns the daemon with it.',
  'macaroon-root-key.json':
    'never-copied: every act-plane token chains from it and a restore does not rotate it, so a leaked backup mints macaroons against the live daemon. Costs only reissuance to lose, which its own header calls the expected price.',
  'backup-in-progress.json':
    "never-copied: this command's own bookkeeping; a copy in a restored dir claims a backup is running there.",

  'daemon-identity.json':
    'never-copied: the Ed25519 private key behind the daemon did:key, the actor its versions name. Decided 2026-09-19 against a real cost — a restored daemon gets a fresh identity, so pairings must be redone and old versions name a former actor. Taken because that is recoverable and a signing key in a backup is not.',
  'migration.lock':
    'copied: exists only while a starting process migrates, so a backup rarely meets one. A restored one is judged like any other: the next start replaces it unless the pid it names is a live process that started before the file was written (stale-lock.ts). One recorded on another host is waited out to the bound, whose error names the file to remove.',
  'storage.json':
    'copied: the database location record. A restore needs it to find the database it just restored.',
  'whiteboard.db':
    'copied: the database itself — the point of the backup. `excludeDatabaseFile` is a per-call option, not a standing exclusion.',

  'daemon.lock':
    'copied: a directory that exists only while a daemon starts, so a backup rarely meets one. A restored one is judged like any lock (stale-lock.ts): replaced when its owner exited, its pid was reused, or it names no owner past the grace; one recorded on another host is waited out to the startup bound, whose error names the directory to remove.',
  'owner.json':
    "copied: the holder record inside daemon.lock (mkdir-lock.ts), and judged with it — see daemon.lock's entry.",
  '.pending-writes':
    'never-copied: writes staged before their rename into place; a copy would restore a write that never committed.',
  tenants: "copied: every tenant's stored workspaces, blobs and files — what a backup exists for.",
  workspaces: 'copied: the per-workspace directories under each tenant.',
  blobs:
    "copied: a tenant's document blobs (`excludeBlobs` is a per-call option for the mirror, not a standing exclusion). Also the backup mirror's own flat store.",
  files: "copied: a workspace's uploaded files. Also the backup mirror's own flat store.",
  exports: 'copied: files a person asked to have written out, under the workspace id.',
  fonts:
    'copied: installed fonts the export measurer reads; a restore without them would render with fallbacks.',
  models:
    'never-copied: the ~113 MB search model cache, re-downloadable. Losing it costs semantic ranking only — the daemon loads weights offline and never fetches, so search stays lexical until `whiteboard search fetch-model` is run again.',
  'native-host':
    'never-copied: the launcher names the data dir and node binary it was installed for (and on Windows the manifests the registry points at). A restore always lands in a fresh dir, so a copy would relay the extension to the old one; `whiteboard native-host install` rewrites it.',
  'server-mode.json':
    "copied: server mode's own backup keeps it in the archive on purpose, and `restoreServerModeDataDir` deletes it from the restored tree so a fresh `whiteboard server run` writes its own (server-mode-backup-restore.ts).",

  'blobs.json':
    'not-in-data-dir: the blob manifest inside a backup MIRROR directory, written by backup-blob-mirror.ts.',
} satisfies Record<string, BackupDisposition>

/**
 * Every `…FILENAME = '<name>'` and `…DIRNAME = '<name>'` constant this package
 * declares: the copy is recursive, so a directory is copied whole as readily as
 * a file. A name spelled inline as `join(<…dataDir>, '<name>')` is read too,
 * because that spelling is how the model cache, the server-mode record and the
 * native-host directory each escaped this ledger.
 */
const DECLARED_NAME = /(?:^|\s)[A-Z_]*(?:FILENAME|DIRNAME)\s*=\s*'([^']+)'/gm
const INLINE_DATA_DIR_NAME = /join\(\s*[A-Za-z_.]*[dD]ataDir[A-Za-z]*\s*,\s*'([^']+)'/g

async function scanDeclaredFilenames(): Promise<Set<string>> {
  const found = new Set<string>()
  for (const file of productionSourceFiles(PACKAGE_SRC, { extensions: ['.ts'] })) {
    const source = await readFile(file, 'utf8')
    for (const pattern of [DECLARED_NAME, INLINE_DATA_DIR_NAME]) {
      for (const match of source.matchAll(pattern)) found.add(match[1] as string)
    }
  }
  return found
}

describe('every data-dir filename is classified against what a backup copies', () => {
  // A count, because a regex that stops matching otherwise reports itself as
  // "every entry is stale" and sends the reader to the wrong file entirely.
  it('finds a plausible number of declared filenames', async () => {
    expect((await scanDeclaredFilenames()).size).toBeGreaterThanOrEqual(16)
  })

  it('classifies every filename the source declares', async () => {
    const unclassified = [...(await scanDeclaredFilenames())].filter(
      (name) => !(name in BACKUP_DISPOSITION),
    )
    expect(
      unclassified,
      'A file the daemon writes has no entry in BACKUP_DISPOSITION. `backupDataDir` copies the data dir recursively, so an unclassified file is COPIED into every backup by default. Decide, then add the entry.',
    ).toEqual([])
  })

  it('names nothing the source no longer declares', async () => {
    const declared = await scanDeclaredFilenames()
    const stale = Object.keys(BACKUP_DISPOSITION).filter((name) => !declared.has(name))
    expect(stale, 'BACKUP_DISPOSITION names a file that no longer exists.').toEqual([])
  })
})

describe('the ledger agrees with the exclusion list it describes', () => {
  it('excludes exactly the files classified never-copied', () => {
    const classifiedNeverCopied = Object.entries(BACKUP_DISPOSITION)
      .filter(([, d]) => d.startsWith('never-copied:'))
      .map(([name]) => name)
      .sort()

    expect([...NEVER_COPIED_FOR_TESTS].sort()).toEqual(classifiedNeverCopied)
  })
})
