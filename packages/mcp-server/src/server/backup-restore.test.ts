import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// DATA_DIR is read-through a getter so tests can swap the dir mid-run.
// This is the same pattern document-store.test.ts uses.
let dataDir: string

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { backupDataDir, restoreDataDir, BackupError } = await import('./backup-restore.js')
const { PENDING_WRITES_DIRNAME } = await import('./atomic-write.js')
const { saveDocument, listDocuments, loadDocument } = await import('./store/document-store.js')
const { FileVersionStore } = await import('./store/version-store.js')
const { clearDbCache } = await import('./store/db/index.js')
const { clearPrepareCache } = await import('./store/db/prepare.js')

interface DrillRoots {
  root: string
  src: string
  backup: string
  target: string
  canary: string
}

async function makeDrillRoots(): Promise<DrillRoots> {
  const root = await mkdtemp(join(tmpdir(), 'whiteboard-backup-drill-'))
  const src = join(root, 'src')
  const backup = join(root, 'backup')
  const target = join(root, 'target')
  const canary = join(root, 'canary.txt')
  await mkdir(src, { recursive: true })
  // canary lives alongside src/backup/target — non-destructive guard
  // assertions check it survives every operation.
  await writeFile(canary, 'canary-content')
  return { root, src, backup, target, canary }
}

async function seedDataDir(dir: string): Promise<{
  canvasElements: { id: string; type: string }[]
  fileBytes: Uint8Array
  versionId: string
}> {
  // Seed via the real store APIs so the backup/restore drill exercises
  // the actual on-disk layout (DB + blobs + per-workspace files dir).
  dataDir = dir
  await mkdir(join(dir, 'session1', 'files'), { recursive: true })

  // Canvas with a deterministic element.
  const doc = new LoroDoc()
  const list = doc.getMovableList('elements')
  const map = list.insertContainer(0, new LoroMap())
  map.set('id', 'elem-001')
  map.set('type', 'rectangle')
  doc.commit()
  await saveDocument('session1', 'canvas-a', doc)

  // File blob (image attachment) at <ws>/files/<fileId>.<ext>.
  const fileBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  await writeFile(join(dir, 'session1', 'files', 'file-001.png'), fileBytes)

  // Version metadata + thumbnail.
  const versions = new FileVersionStore()
  const created = await versions.save('session1', 'canvas-a', doc, {
    auto: false,
    label: 'drill-seed',
  })
  await versions.saveThumbnail(
    'session1',
    'canvas-a',
    created.id,
    new Uint8Array([0x01, 0x02, 0x03]),
  )

  return {
    canvasElements: list.toJSON() as { id: string; type: string }[],
    fileBytes,
    versionId: created.id,
  }
}

beforeEach(() => {
  dataDir = ''
})

afterEach(async () => {
  // Drop cached libsql connections / prepare results so the next test
  // can rebuild them against a fresh dataDir without leaking state.
  clearDbCache()
  clearPrepareCache()
})

describe('backup-restore drill', () => {
  it('happy path: seeded data dir is backed up, restored to a fresh dir, and reads back identically', async () => {
    const roots = await makeDrillRoots()
    try {
      const seeded = await seedDataDir(roots.src)

      await backupDataDir(roots.src, roots.backup, { allowedRoots: [roots.root] })
      // Make sure prior cached connections do not bleed into the
      // restored dir — restore is a fresh-process drill.
      clearDbCache()
      clearPrepareCache()
      await restoreDataDir(roots.backup, roots.target, { allowedRoots: [roots.root] })

      // Re-point DATA_DIR at the restored copy and verify.
      dataDir = roots.target
      const documents = await listDocuments('session1')
      expect(documents.map((c) => c.path)).toContain('canvas-a')

      const restoredDoc = await loadDocument('session1', 'canvas-a')
      const restoredElements = restoredDoc.getMovableList('elements').toJSON() as {
        id: string
        type: string
      }[]
      expect(restoredElements).toEqual(seeded.canvasElements)

      const restoredBlob = await readFile(join(roots.target, 'session1', 'files', 'file-001.png'))
      expect(new Uint8Array(restoredBlob)).toEqual(seeded.fileBytes)

      const versions = new FileVersionStore()
      const list = await versions.list('session1', 'canvas-a')
      expect(list.find((v) => v.id === seeded.versionId)?.label).toBe('drill-seed')
      const thumb = await versions.loadThumbnail('session1', 'canvas-a', seeded.versionId)
      expect(thumb).not.toBeNull()
      expect(Array.from(thumb ?? new Uint8Array())).toEqual([0x01, 0x02, 0x03])
    } finally {
      await rm(roots.root, { recursive: true, force: true })
    }
  })

  it('non-destructive: source survives intact and a sibling canary is untouched after both backup and restore', async () => {
    const roots = await makeDrillRoots()
    try {
      await seedDataDir(roots.src)
      await backupDataDir(roots.src, roots.backup, { allowedRoots: [roots.root] })
      await restoreDataDir(roots.backup, roots.target, { allowedRoots: [roots.root] })

      // Source canvas blob must still be present.
      dataDir = roots.src
      const srcList = await listDocuments('session1')
      expect(srcList.map((c) => c.path)).toContain('canvas-a')

      // Canary outside src/backup/target is preserved.
      const canary = await readFile(roots.canary, 'utf8')
      expect(canary).toBe('canary-content')
    } finally {
      await rm(roots.root, { recursive: true, force: true })
    }
  })

  it('fail-closed: restore into a non-empty target rejects without touching the target', async () => {
    const roots = await makeDrillRoots()
    try {
      await seedDataDir(roots.src)
      await backupDataDir(roots.src, roots.backup, { allowedRoots: [roots.root] })

      // Pre-populate target with an unrelated canary file.
      await mkdir(roots.target, { recursive: true })
      const targetCanary = join(roots.target, 'pre-existing.txt')
      await writeFile(targetCanary, 'pre-existing-content')

      await expect(
        restoreDataDir(roots.backup, roots.target, { allowedRoots: [roots.root] }),
      ).rejects.toBeInstanceOf(BackupError)

      // Target's pre-existing file must still be there exactly.
      const after = await readFile(targetCanary, 'utf8')
      expect(after).toBe('pre-existing-content')
    } finally {
      await rm(roots.root, { recursive: true, force: true })
    }
  })

  it('path guard: backup refuses to operate outside any allowed root', async () => {
    const roots = await makeDrillRoots()
    const other = await mkdtemp(join(tmpdir(), 'whiteboard-backup-other-'))
    try {
      await seedDataDir(roots.src)
      // Source is fine, but `backup` lives outside the allowed-roots list.
      await expect(
        backupDataDir(roots.src, join(other, 'b'), { allowedRoots: [roots.root] }),
      ).rejects.toBeInstanceOf(BackupError)
    } finally {
      await rm(roots.root, { recursive: true, force: true })
      await rm(other, { recursive: true, force: true })
    }
  })

  it('symlink rejection on backup: a symlink inside the source rejects with BackupError and leaves the backup dir empty', async () => {
    const roots = await makeDrillRoots()
    const outside = await mkdtemp(join(tmpdir(), 'whiteboard-backup-outside-'))
    try {
      await seedDataDir(roots.src)
      // Drop a symlink inside the seeded src that points outside the
      // src tree — exactly the exfiltration shape the contract bans.
      await writeFile(join(outside, 'attacker-secret.txt'), 'attacker-content')
      await symlink(
        join(outside, 'attacker-secret.txt'),
        join(roots.src, 'session1', 'files', 'evil-link.png'),
      )

      let caught: unknown
      await backupDataDir(roots.src, roots.backup, { allowedRoots: [roots.root] }).catch((err) => {
        caught = err
      })
      expect(caught).toBeInstanceOf(BackupError)
      expect((caught as Error).message).toMatch(/symlink/i)

      // backupDir must remain untouched (still empty / missing). cp may
      // create the dir before failing, so accept either "missing" or
      // "exists but empty".
      let backupEntries: string[] = []
      try {
        backupEntries = await readdir(roots.backup)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      expect(backupEntries).toEqual([])
    } finally {
      await rm(roots.root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('symlink rejection on restore: a symlink inside the backup rejects and leaves the target empty', async () => {
    const roots = await makeDrillRoots()
    const outside = await mkdtemp(join(tmpdir(), 'whiteboard-backup-outside-'))
    try {
      // Build a hand-crafted "backup" tree directly (skipping
      // backupDataDir, which would already reject the symlink).
      // Simulates a backup produced by another tool that the user
      // hands us at restore time.
      await mkdir(join(roots.backup, 'session1', 'files'), { recursive: true })
      await writeFile(join(roots.backup, 'whiteboard.db'), 'fake-db')
      await writeFile(join(outside, 'attacker-secret.txt'), 'attacker-content')
      await symlink(
        join(outside, 'attacker-secret.txt'),
        join(roots.backup, 'session1', 'files', 'evil-link.png'),
      )

      let caught: unknown
      await restoreDataDir(roots.backup, roots.target, { allowedRoots: [roots.root] }).catch(
        (err) => {
          caught = err
        },
      )
      expect(caught).toBeInstanceOf(BackupError)
      expect((caught as Error).message).toMatch(/symlink/i)

      // Target must be empty / missing after the rejection.
      let targetEntries: string[] = []
      try {
        targetEntries = await readdir(roots.target)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      expect(targetEntries).toEqual([])
    } finally {
      await rm(roots.root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('path guard: ancestor symlink pointing outside allowedRoots is rejected and outside dir remains empty', async () => {
    const roots = await makeDrillRoots()
    const outside = await mkdtemp(join(tmpdir(), 'whiteboard-backup-outside-'))
    try {
      await seedDataDir(roots.src)
      await backupDataDir(roots.src, roots.backup, { allowedRoots: [roots.root] })

      // Symlink inside roots.root whose target is outside the allowed tree.
      const linkPath = join(roots.root, 'link-to-outside')
      await symlink(outside, linkPath)

      // restoreDataDir target path traverses the ancestor symlink → resolves
      // to outside/restored which is outside allowedRoots.
      await expect(
        restoreDataDir(roots.backup, join(linkPath, 'restored'), { allowedRoots: [roots.root] }),
      ).rejects.toBeInstanceOf(BackupError)

      // Nothing must have been written to the outside dir.
      const outsideEntries = await readdir(outside)
      expect(outsideEntries).toEqual([])
    } finally {
      await rm(roots.root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('safe-error: missing backup dir rejects with a generic message that does not echo the resolved path', async () => {
    const roots = await makeDrillRoots()
    try {
      let caught: unknown
      await restoreDataDir(join(roots.root, 'missing'), roots.target, {
        allowedRoots: [roots.root],
      }).catch((err) => {
        caught = err
      })
      expect(caught).toBeInstanceOf(BackupError)
      const msg = (caught as Error).message
      // Generic copy only — must NOT carry the absolute path, the OS
      // tmp prefix, the resolved canonical path, a stack frame, or
      // any token-like substring.
      expect(msg).not.toContain(roots.root)
      expect(msg).not.toMatch(/\/Users\//)
      expect(msg).not.toMatch(/\/private\//)
      expect(msg).not.toMatch(/\/tmp\//)
      expect(msg).not.toMatch(/\.ts:\d/)
      expect(msg).not.toMatch(/Bearer/i)
      expect(msg).toMatch(/does not exist/i)
    } finally {
      await rm(roots.root, { recursive: true, force: true })
    }
  })
})

/**
 * A fossil must not travel into a backup.
 *
 * An operator who moved their rows to a libSQL server and left the old
 * `whiteboard.db` in the data directory has a file that looks exactly like a
 * live database and holds pre-migration rows. Copying it produces a backup
 * that restore would put back as though it were current — the same silent
 * data loss this whole area exists to prevent, arriving by a different route.
 *
 * Everything else in the directory is still ours and still copied: the blobs
 * are precisely what no libSQL provider is backing up.
 */
describe('backupDataDir with excludeDatabaseFile', () => {
  it('copies the blobs but leaves the stale database behind', async () => {
    const roots = await makeDrillRoots()
    try {
      await mkdir(join(roots.src, 'blobs', 'ab'), { recursive: true })
      await writeFile(join(roots.src, 'blobs', 'ab', 'cdef'), 'blob bytes')
      await writeFile(join(roots.src, 'whiteboard.db'), 'pre-migration rows')
      await writeFile(
        join(roots.src, 'storage.json'),
        '{"schemaVersion":1,"database":{"inDataDir":false}}',
      )

      // WAL sidecars, which a fossil in a WAL database has beside it.
      await writeFile(join(roots.src, 'whiteboard.db-wal'), 'uncheckpointed rows')
      await writeFile(join(roots.src, 'whiteboard.db-shm'), 'shared memory')

      await backupDataDir(roots.src, roots.backup, {
        allowedRoots: [roots.root],
        excludeDatabaseFile: true,
      })

      // The sidecars go with it. A `-wal` left behind on its own is a
      // fragment of the very pre-migration rows the exclusion exists to keep
      // out — and SQLite would replay it into any `whiteboard.db` later put
      // beside it.
      const copied = await readdir(roots.backup)
      expect(copied.filter((f) => f.startsWith('whiteboard.db'))).toEqual([])

      expect(await readFile(join(roots.backup, 'blobs', 'ab', 'cdef'), 'utf8')).toBe('blob bytes')
      // The record travels: it is how restore later knows this backup was
      // never meant to hold rows.
      expect(await readFile(join(roots.backup, 'storage.json'), 'utf8')).toContain(
        '"inDataDir":false',
      )
      expect(await readdir(roots.backup)).not.toContain('whiteboard.db')
    } finally {
      await rm(roots.root, { recursive: true, force: true })
    }
  })

  it('copies the database when the option is absent', async () => {
    const roots = await makeDrillRoots()
    try {
      await writeFile(join(roots.src, 'whiteboard.db'), 'rows')
      await backupDataDir(roots.src, roots.backup, { allowedRoots: [roots.root] })
      expect(await readFile(join(roots.backup, 'whiteboard.db'), 'utf8')).toBe('rows')
    } finally {
      await rm(roots.root, { recursive: true, force: true })
    }
  })
})

/**
 * The blob store's temp area must never reach a backup.
 *
 * Atomic blob writes land beside the target and `rename` onto it, so a temp
 * file exists for the duration of every write. It is not content — it is
 * mid-flight bytes under a name no digest matches — and copying it puts a
 * file in the backup that nothing can ever resolve.
 *
 * It also removes the copy's most common way to die. `cp` enumerates a
 * directory and then stats each entry; a temp file listed and renamed away
 * before the stat raises ENOENT, which aborts the WHOLE backup. Measured on a
 * copy overlapping a 6 MiB rewrite: the copy crashed with
 * `ENOENT: lstat '.../.<digest>.<uuid>.tmp'`. Excluding the directory
 * removes the file this hits; a copy taken while a server is genuinely
 * writing needs more than this, and that is ADR-0021 decision 3's job.
 */
describe('backupDataDir and the blob temp area', () => {
  it('does not copy the temp directory into the backup', async () => {
    const roots = await makeDrillRoots()
    try {
      await mkdir(join(roots.src, PENDING_WRITES_DIRNAME), { recursive: true })
      await writeFile(join(roots.src, PENDING_WRITES_DIRNAME, 'half-written.tmp'), 'partial')
      await mkdir(join(roots.src, 'blobs', 'ab'), { recursive: true })
      await writeFile(join(roots.src, 'blobs', 'ab', 'cdef'), 'blob bytes')
      await writeFile(join(roots.src, 'whiteboard.db'), 'rows')

      await backupDataDir(roots.src, roots.backup, { allowedRoots: [roots.root] })

      expect(await readdir(roots.backup)).not.toContain(PENDING_WRITES_DIRNAME)
      // Everything real still travels.
      expect(await readFile(join(roots.backup, 'blobs', 'ab', 'cdef'), 'utf8')).toBe('blob bytes')
      expect(await readFile(join(roots.backup, 'whiteboard.db'), 'utf8')).toBe('rows')
    } finally {
      await rm(roots.root, { recursive: true, force: true })
    }
  })
})

/**
 * A backup must not carry a live credential.
 *
 * `daemon.json` holds the Bearer token the daemon authenticates HTTP and WS
 * with, which is why it is written 0o600. A backup directory is the opposite
 * of owner-only: it gets copied to another disk, shipped to support, kept for
 * months. Before backups could be taken hot the file was never present during
 * one — the command refused while the server ran — so enabling that is
 * exactly what would have started leaking it.
 *
 * The in-progress marker goes too. It is this command's own bookkeeping, and
 * a copy of it in a restored data directory is a claim that a backup is
 * running there.
 */
describe('backupDataDir and files that must not travel', () => {
  it('leaves the daemon record and the backup marker out of the copy', async () => {
    const roots = await makeDrillRoots()
    try {
      await writeFile(join(roots.src, 'daemon.json'), '{"token":"super-secret-bearer"}')
      await writeFile(join(roots.src, 'backup-in-progress.json'), '{"schemaVersion":1}')
      await writeFile(join(roots.src, 'whiteboard.db'), 'rows')
      await mkdir(join(roots.src, 'blobs'), { recursive: true })
      await writeFile(join(roots.src, 'blobs', 'keep'), 'blob bytes')

      await backupDataDir(roots.src, roots.backup, { allowedRoots: [roots.root] })

      const copied = await readdir(roots.backup)
      expect(copied).not.toContain('daemon.json')
      expect(copied).not.toContain('backup-in-progress.json')
      // Everything real still travels.
      expect(await readFile(join(roots.backup, 'blobs', 'keep'), 'utf8')).toBe('blob bytes')
    } finally {
      await rm(roots.root, { recursive: true, force: true })
    }
  })
})
