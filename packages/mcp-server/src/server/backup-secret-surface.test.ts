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
 * fresh at spawn) while the daemon's identity key costs every pairing and
 * every past attestation. So each entry says which, and why.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
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
    'copied: UNDER REVIEW. It is an Ed25519 private key and the leak argument applies, but excluding it changes the daemon did:key on restore, which breaks every pairing and leaves past version attestations unverifiable (ADR-0039). Unlike the macaroon key this is a real tradeoff, so the behaviour is unchanged until it is decided rather than flipped in passing.',
  'pairing-grants.json':
    'copied: a record of which origins the user trusted, not a key — the session tokens minted against a grant are memory-only (pairing-token-store.ts). A restore that lost it would silently un-pair every origin.',
  'webauthn-credentials.json':
    'copied: passkey PUBLIC keys and signature counters. Not a secret, and a restore without them cannot verify any registered passkey.',
  'storage.json':
    'copied: the database location record. A restore needs it to find the database it just restored.',
  'whiteboard.db':
    'copied: the database itself — the point of the backup. `excludeDatabaseFile` is a per-call option, not a standing exclusion.',

  'blobs.json':
    'not-in-data-dir: the blob manifest inside a backup MIRROR directory, written by backup-blob-mirror.ts.',
  'owner.json':
    'not-in-data-dir: mkdir-lock.ts writes it inside the lock directory it creates, wherever the caller puts that.',
} satisfies Record<string, BackupDisposition>

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(path)))
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(path)
  }
  return out
}

/** Every `…FILENAME = '<name>'` constant this package declares. */
async function scanDeclaredFilenames(): Promise<Set<string>> {
  const found = new Set<string>()
  for (const file of await walk(PACKAGE_SRC)) {
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(/(?:^|\s)[A-Z_]*FILENAME\s*=\s*'([^']+)'/gm)) {
      found.add(match[1] as string)
    }
  }
  return found
}

describe('every data-dir filename is classified against what a backup copies', () => {
  // A count, because a regex that stops matching otherwise reports itself as
  // "every entry is stale" and sends the reader to the wrong file entirely.
  it('finds a plausible number of declared filenames', async () => {
    expect((await scanDeclaredFilenames()).size).toBeGreaterThanOrEqual(8)
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

    // `pending-writes` is a DIRECTORY rather than a declared filename, so it
    // is in the exclusion list and cannot be in a filename ledger.
    const excludedFiles = NEVER_COPIED_FOR_TESTS.filter((name) => name.endsWith('.json')).sort()

    expect(excludedFiles).toEqual(classifiedNeverCopied)
  })
})
