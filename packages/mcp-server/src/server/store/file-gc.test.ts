import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newImageRef } from '@kamiazya/whiteboard-model'
import { fileNode, groupNode, workspaceIdFor } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceDir, workspaceFilesDir } from '../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'

const GC_BACKUP_FINISHED = '01M9F6SQQSRV3QB5E5NTTX7P1Y'
const GC_BACKUP_RUNNING = '0126533FESFSY53NW8DNJZY9NS'
const GC_OTHER_INSTANCE = '01MT5T2HWFS2VW9019N1YA0XA2'
const GC_OTHER_INSTANCE_DANGLING = '014372C165ZN3XZ7JBR9PDNC3F'
const GC_RECORD_MOVED = '01FME2G1DYV5TWG335HBPTXJRB'
const WS_A = '01TYGJP26XH16QHBBVNW85QCE0'
const WS_BG = '01BS99RZNWCCAPYP9GEZXKMBMG'
const WS_BRK = '01XJ5VATJBAN5M2VN2WXB8XTGG'
const WS_DEFERRED = '01SJV6TZ3F6DMGSKW0D9Z0VRWK'
const WS_EMPTY = '01QSZ6KW045NSFV5A6WQ719EGF'
const WS_ENV = '01D5XSB5W7833AP9V95CQHGXBE'
const WS_FILES_LINK = '01ZAVFNS1E3NG0T5ARVZYPFWZ9'
const WS_GRACE = '019JF6Y6DDX662KHRMC5SHVTZ1'
const WS_GRACE0 = '014YJ0ZJP9BR9AHX4ZG8K9N2K5'
const WS_LEGACY = '0149W95NTZ1DZPVKF0NG8BBBRH'
const WS_MD = '01VJV1X9QGRPM3C44GXX8GC75V'
const WS_MIXED = '0109C0KGY79BZNT3H78M6B74KP'
const WS_NODES = '01MAC3KBFGR1BZTEKSGS5K84EB'
const WS_NOSCAN = '01225QZFEZZ4415V2297YNMM1G'
const WS_NULLVER = '017N5PKBRTSH0SR8DYDPS1H2EJ'
const WS_PRECISION = '01YWQG4W6PX485CAW3RT99S50A'
const WS_PURGED = '01E79AM73BMY373CJA9G72C5FP'
const WS_RACE = '01KX3TVDNQV2JZS71CYZ5R9641'
const WS_TRASH = '017E2PJZQV8ZPMN39SVSPZ9H52'
const WS_UNREADABLE = '01MVE8AT3F5JXZ49DZMVQ0W37V'
const WS_V = '011NS8H5QYXT03TKXY3CSNQBWB'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { saveDocument, loadDocument, listDocuments } = await import('./document-store.js')
const { purgeDanglingFiles, IncompleteFileGcScanError } = await import('./file-gc.js')
const { withBackupMarker } = await import('./backup-in-progress.js')
const { captureLogsForTests } = await import('../log.js')
const { FileVersionStore } = await import('./version-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { makeSpatialDoc, makeSpatialDocWithImage, setSpatialDocImage } = await import(
  '../../shared/test-utils/spatial-doc.js'
)

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

/** The version store every production caller passes, over this test's data dir. */
function withVersions(extra: { graceMs?: number } = {}) {
  return { versionStore: new FileVersionStore(), ...extra }
}

const { DocumentStoreWorkspaceDocs } = await import('@kamiazya/whiteboard-workspace-index')
const { createWorkspaceDocumentAtPath, writeWorkspaceDocumentContent } = await import(
  '@kamiazya/whiteboard-loro-adapter'
)
const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')

/**
 * A write from ANOTHER instance: straight to the store, never through this
 * module's cached workspace document.
 *
 * That is what a second daemon is — same data directory, its own process,
 * its own cache — and it is the only way to put this instance's cache
 * behind the record without reaching into the cache itself.
 */
async function writeFromOtherInstance(
  workspaceId: string,
  path: string,
  documentId: string,
  content: LoroDoc,
): Promise<void> {
  const docs = new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(handle.db))
  const workspaceDoc = (await docs.open(workspaceId)) ?? new LoroDoc()
  createWorkspaceDocumentAtPath(workspaceDoc, { path, documentId, kind: 'spatial' })
  writeWorkspaceDocumentContent(workspaceDoc, documentId, content)
  await docs.save(workspaceId, workspaceDoc)
}

async function seedFile(
  workspaceId: string,
  fileId: string,
  ext: string,
  bytes: number,
): Promise<void> {
  const dir = workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, workspaceId)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${fileId}${ext}`)
  await writeFile(path, Buffer.alloc(bytes, 0xab))
  // Age the file beyond the default GC grace window so existing
  // dangling-files tests see the unlink path. Tests that exercise the
  // grace window itself create files without calling seedFile (or use
  // seedFreshFile below).
  const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000
  await utimes(path, past, past)
}

async function seedFreshFile(
  workspaceId: string,
  fileId: string,
  ext: string,
  bytes: number,
): Promise<void> {
  const dir = workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, workspaceId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${fileId}${ext}`), Buffer.alloc(bytes, 0xcd))
}

// The retired 'elements' shape, for the tests that pin that nothing reads
// it any more. Every other test seeds through the current nodes-model fixture
// (spatial-doc.js) instead.
function makeDocWithImage(fileId: string): LoroDoc {
  const doc = new LoroDoc()
  const list = doc.getMovableList('elements')
  const map = list.insertContainer(0, new LoroMap())
  map.set('id', `el-${fileId}`)
  map.set('type', 'image')
  map.set('fileId', fileId)
  map.set('isDeleted', false)
  doc.commit()
  return doc
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-file-gc-test-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
})

afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

describe('purgeDanglingFiles', () => {
  it('keeps a file referenced by a CURRENT nodes-model file node (production doc shape)', async () => {
    // Production docs write spatial content into the nodes/edges model, not
    // the retired 'elements' movable list — this is the shape every daemon
    // actually persists through saveDocument. Before the fix this must be RED:
    // the collector only walks 'elements' and returns an empty set, so the
    // aged file below is (wrongly) classified as dangling and unlinked.
    await saveDocument(WS_NODES, 'page', makeSpatialDocWithImage('asset-x'))
    await seedFile(WS_NODES, 'asset-x', '.png', 500)

    const result = await purgeDanglingFiles(WS_NODES, withVersions())

    expect(result.purgedCount).toBe(0)
    const remaining = (
      await readdir(workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, WS_NODES))
    ).sort()
    expect(remaining).toEqual(['asset-x.png'])
  })

  it('keeps files referenced by nodes-model file nodes and deletes the rest', async () => {
    // Two documents reference distinct fileIds; an additional dangling file
    // qualifies for deletion.
    await saveDocument(WS_A, 'used-a', makeSpatialDocWithImage('used-a'))
    await saveDocument(WS_A, 'used-b', makeSpatialDocWithImage('used-b'))

    await seedFile(WS_A, 'used-a', '.png', 100)
    await seedFile(WS_A, 'used-b', '.png', 200)
    await seedFile(WS_A, 'orphan-1', '.png', 1000)
    await seedFile(WS_A, 'orphan-2', '.jpg', 500)

    const result = await purgeDanglingFiles(WS_A, withVersions())

    expect(result.purgedCount).toBe(2)
    expect(result.purgedBytes).toBe(1500)

    const remaining = (await readdir(workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, WS_A))).sort()
    expect(remaining).toEqual(['used-a.png', 'used-b.png'])
  })

  it('a doc holding only the retired elements list protects no file', async () => {
    // Nothing converts that list into nodes and no reader draws it, so an
    // image only it names is as unreachable as an orphan upload.
    await saveDocument(WS_LEGACY, 'page', makeDocWithImage('legacy-image'))
    await seedFile(WS_LEGACY, 'legacy-image', '.png', 321)

    const result = await purgeDanglingFiles(WS_LEGACY, withVersions())

    expect(result.purgedCount).toBe(1)
    expect(result.purgedBytes).toBe(321)
  })

  it('returns zero counts for a workspace with no files dir yet', async () => {
    const result = await purgeDanglingFiles(WS_EMPTY, withVersions())
    expect(result).toEqual({ purgedCount: 0, purgedBytes: 0 })
  })

  it('refuses, deleting nothing, when files/ is a symlink out of the data dir', async () => {
    // The lexical join every caller builds the files dir from cannot see a
    // symlink, so the purge itself decides containment — the route and the
    // sweeper alike reach it only through here.
    const outside = await mkdtemp(join(tmpdir(), 'whiteboard-file-gc-outside-'))
    try {
      await writeFile(join(outside, 'victim.png'), Buffer.alloc(10, 1))
      const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000
      await utimes(join(outside, 'victim.png'), past, past)
      const dir = workspaceDir(tempDir, SELF_HOST_TENANT_ID, WS_FILES_LINK)
      await mkdir(dir, { recursive: true })
      await symlink(outside, join(dir, 'files'), 'dir')

      await expect(purgeDanglingFiles(WS_FILES_LINK, withVersions())).rejects.toMatchObject({
        name: 'FilesDirNotContainedError',
        workspaceId: WS_FILES_LINK,
      })
      expect(await readdir(outside)).toEqual(['victim.png'])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('mixed workspace: a nodes-model doc protects its file while a legacy-elements doc does not', async () => {
    await saveDocument(WS_MIXED, 'legacy-page', makeDocWithImage('legacy-ref'))
    await saveDocument(WS_MIXED, 'nodes-page', makeSpatialDocWithImage('nodes-ref'))

    await seedFile(WS_MIXED, 'legacy-ref', '.png', 10)
    await seedFile(WS_MIXED, 'nodes-ref', '.png', 20)
    await seedFile(WS_MIXED, 'unrelated-orphan', '.png', 30)

    const result = await purgeDanglingFiles(WS_MIXED, withVersions())

    expect(result.purgedCount).toBe(2)
    expect(result.purgedBytes).toBe(40)
    const remaining = (
      await readdir(workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, WS_MIXED))
    ).sort()
    expect(remaining).toEqual(['nodes-ref.png'])
  })

  it('does not protect an upload whose id merely matches a plain (non-asset:) file value', async () => {
    // Precision: a 'file' node's `file` value can also be a document
    // reference (wikilink-style embed) rather than an upload — only the
    // 'asset:' prefix means "this points at an uploaded blob". A same-named
    // orphan upload must not be spared by a document-path collision.
    await saveDocument(
      WS_PRECISION,
      'page',
      makeSpatialDoc({
        nodes: [fileNode({ id: 'n1', file: 'some-canvas', x: 0, y: 0, width: 100, height: 100 })],
        edges: [],
      }),
    )
    await seedFile(WS_PRECISION, 'some-canvas', '.png', 42)

    const result = await purgeDanglingFiles(WS_PRECISION, withVersions())

    expect(result.purgedCount).toBe(1)
    expect(result.purgedBytes).toBe(42)
  })

  it('keeps files referenced by a saved version when versionStore is supplied', async () => {
    // Step 1: live state references "version-only" via a file node.
    await saveDocument(WS_V, 'evolving', makeSpatialDocWithImage('version-only'))
    const store = new FileVersionStore()
    await store.save(WS_V, 'evolving', await loadDocument(WS_V, 'evolving'), { auto: false })

    // Step 2: live state changes — the original node is replaced by a
    // brand-new one. After this the live doc references only "live-now",
    // while the saved version still points at "version-only".
    const live = await loadDocument(WS_V, 'evolving')
    setSpatialDocImage(live, 'live-now')
    await saveDocument(WS_V, 'evolving', live, { overwrite: true })

    await seedFile(WS_V, 'version-only', '.png', 700)
    await seedFile(WS_V, 'live-now', '.png', 300)
    await seedFile(WS_V, 'truly-dangling', '.png', 100)

    const result = await purgeDanglingFiles(WS_V, { versionStore: store })
    // Only "truly-dangling" gets dropped — the version-only reference is
    // protected by walking past versions.
    expect(result.purgedCount).toBe(1)
    expect(result.purgedBytes).toBe(100)

    const remaining = (await readdir(workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, WS_V))).sort()
    expect(remaining).toEqual(['live-now.png', 'version-only.png'])
  })

  it('refuses to purge when a saved version cannot be inspected', async () => {
    // The dangerous case: list() reports a version exists but load()
    // throws, so we cannot enumerate the fileIds it referenced. The
    // older code logged + skipped, which was equivalent to "those files
    // are dangling, delete them" — permanent data loss. Now the GC
    // pass must fail closed and leave every file on disk untouched.
    // Install a structured-log capture so the warning surface is
    // asserted alongside the fail-closed contract — silent skipping is
    // the very behaviour this test exists to prevent.
    const cap = captureLogsForTests('debug')

    await saveDocument(WS_BRK, 'broken', makeSpatialDocWithImage('only-by-broken-version'))
    await seedFile(WS_BRK, 'only-by-broken-version', '.png', 222)
    await seedFile(WS_BRK, 'really-dangling', '.png', 33)

    const fakeStore = {
      listIdsByDocument: async () => ['v-broken'],
      openCheckouts: async () => ({
        load: async () => {
          throw new Error('frontier rows missing')
        },
      }),
    }

    await expect(purgeDanglingFiles(WS_BRK, { versionStore: fakeStore })).rejects.toBeInstanceOf(
      IncompleteFileGcScanError,
    )

    // Crucially: nothing was deleted, even though only-by-broken-version
    // would have been classified as dangling under the old behaviour.
    const remaining = (
      await readdir(workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, WS_BRK))
    ).sort()
    expect(remaining).toEqual(['only-by-broken-version.png', 'really-dangling.png'])

    try {
      const fileGcWarnings = cap.records.filter(
        (r) => r.scope === 'file-gc' && r.level === 'warning' && r.msg === 'skipped version',
      )
      expect(fileGcWarnings).toHaveLength(1)
      expect(fileGcWarnings[0].data).toMatchObject({
        workspaceId: WS_BRK,
        path: 'broken',
        versionId: 'v-broken',
      })
    } finally {
      cap.restore()
    }
  })

  it('skips files whose mtime is within the configured grace window (Race C)', async () => {
    // The upload-but-not-yet-saveDocument race: routes/files.ts has just
    // written `pending.png` to disk, but the user has not yet called
    // saveDocument with the matching image element. Without a grace
    // window GC fires here and permanently deletes a file that was
    // about to be referenced. With the default 1-hour grace, freshly-
    // touched files are spared.
    await seedFreshFile(WS_GRACE, 'pending', '.png', 64)
    await seedFile(WS_GRACE, 'old-orphan', '.png', 32)

    const result = await purgeDanglingFiles(WS_GRACE, withVersions())
    // old-orphan is past the grace window, gone. pending is fresh —
    // preserved this round.
    expect(result.purgedCount).toBe(1)
    const remaining = (
      await readdir(workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, WS_GRACE))
    ).sort()
    expect(remaining).toEqual(['pending.png'])
  })

  it('honours an explicit graceMs=0 to bypass the grace window', async () => {
    // Operators who run a manual cleanup right after deciding nothing
    // should be deferred can pass graceMs: 0 to delete fresh dangling
    // files in the same call. Used by the tests above for the same
    // reason.
    await seedFreshFile(WS_GRACE0, 'fresh-orphan', '.png', 16)
    const result = await purgeDanglingFiles(WS_GRACE0, withVersions({ graceMs: 0 }))
    expect(result.purgedCount).toBe(1)
    const remaining = await readdir(workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, WS_GRACE0))
    expect(remaining).toEqual([])
  })

  it('reads the grace window from WHITEBOARD_FILE_GC_GRACE_MS when no option is set', async () => {
    const previous = process.env.WHITEBOARD_FILE_GC_GRACE_MS
    process.env.WHITEBOARD_FILE_GC_GRACE_MS = '0'
    try {
      await seedFreshFile(WS_ENV, 'fresh-orphan', '.png', 8)
      const result = await purgeDanglingFiles(WS_ENV, withVersions())
      expect(result.purgedCount).toBe(1)
    } finally {
      if (previous === undefined) delete process.env.WHITEBOARD_FILE_GC_GRACE_MS
      else process.env.WHITEBOARD_FILE_GC_GRACE_MS = previous
    }
  })

  /**
   * A unit-suffixed value must not become a near-zero window.
   *
   * `Number.parseInt` reads the leading digits and discards the rest, so the
   * most natural way an operator writes one hour — `1h` — resolved to **1
   * millisecond**. This is the one setting whose entire job is protecting the
   * window between an upload finishing and the matching save landing, so
   * silently shrinking it to nothing deletes files that are still in flight.
   *
   * Measured across plausible spellings before the fix:
   * `1h` -> 1ms, `30m` -> 30ms, `2s` -> 2ms, `1e3` -> 1ms.
   *
   * `' 500'` is deliberately NOT in this list: the shared parser trims, so it
   * is a valid 500ms window rather than a rejected value — and as a 500ms
   * grace it would purge the freshly-seeded file whenever the scan ran longer
   * than that, making this test flaky for a reason unrelated to what it
   * checks.
   *
   * The sibling `WHITEBOARD_FILE_GC_INTERVAL_MS` already parsed strictly for
   * exactly this reason. The two were written to different conventions, and
   * only the lenient one guards data.
   */
  it('falls back to the default rather than reading a unit suffix as a millisecond count', async () => {
    const previous = process.env.WHITEBOARD_FILE_GC_GRACE_MS
    try {
      for (const raw of ['1h', '30m', '2s', '1e3', '-1', '1.5']) {
        process.env.WHITEBOARD_FILE_GC_GRACE_MS = raw
        await seedFreshFile(workspaceIdFor(`ws_grace_${raw}`), 'fresh', '.png', 8)
        const result = await purgeDanglingFiles(workspaceIdFor(`ws_grace_${raw}`), withVersions())
        // A freshly-written file is inside the default one-hour window, so a
        // correctly-parsed setting purges nothing. Under the old parse `1h`
        // became 1ms and this file was deleted.
        expect(result.purgedCount, `${raw} must not arm a near-zero grace window`).toBe(0)
      }
    } finally {
      if (previous === undefined) delete process.env.WHITEBOARD_FILE_GC_GRACE_MS
      else process.env.WHITEBOARD_FILE_GC_GRACE_MS = previous
    }
  })

  it('serialises against a concurrent saveDocument that adds a new file reference', async () => {
    // Race scenario: user has foo.png on disk left over from an earlier
    // session, but no canvas references it yet. They open a canvas and
    // add a file node pointing at foo. Just as that saveDocument is
    // committing, a background purgeDanglingFiles fires.
    //
    // Without a workspace write barrier, GC's collectReferencedFileIds
    // could observe the pre-save state (no references) and unlink
    // foo.png. With the lock, the save commits first and the purge
    // pass sees the new reference.
    await seedFile(WS_RACE, 'about-to-reference', '.png', 200)

    const empty = new LoroDoc()
    await saveDocument(WS_RACE, 'page', empty)

    // Build the post-save doc by extending the empty doc.
    const next = await loadDocument(WS_RACE, 'page')
    setSpatialDocImage(next, 'about-to-reference')

    // Kick the save first so it acquires the lock; then kick the purge.
    const savePromise = saveDocument(WS_RACE, 'page', next, { overwrite: true })
    const purgePromise = purgeDanglingFiles(WS_RACE, withVersions())
    const [, purgeResult] = await Promise.all([savePromise, purgePromise])

    expect(purgeResult.purgedCount).toBe(0)
    const remaining = (
      await readdir(workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, WS_RACE))
    ).sort()
    expect(remaining).toEqual(['about-to-reference.png'])
  })

  it('skips the expensive reference scan entirely when there are no candidate files', async () => {
    // A version store that EXPLODES if consulted. With no files/ dir the
    // purge must return zero without ever running collectReferencedFileIds,
    // so the store is never asked and the tripwire never fires. This is what
    // keeps the periodic sweeper cheap on the common no-uploads workspace;
    // reordering the scan back in front of the readdir turns this test red.
    await saveDocument(WS_NOSCAN, 'page', makeSpatialDocWithImage('never-uploaded'))
    const exploding = {
      listIdsByDocument: async () => {
        throw new Error('the reference scan ran when it should have been skipped')
      },
    } as unknown as InstanceType<typeof FileVersionStore>

    await expect(
      purgeDanglingFiles(WS_NOSCAN, { graceMs: 0, versionStore: exploding }),
    ).resolves.toEqual({
      purgedCount: 0,
      purgedBytes: 0,
    })
  })

  it('refuses to purge when a listed version cannot be loaded at all (returns null)', async () => {
    // A silent `if (past) collectFromDoc(...)` skip is equivalent to
    // treating a version we could not load as "referencing nothing" —
    // the same permanent-data-loss hazard as a thrown load() error.
    await saveDocument(WS_NULLVER, 'page', makeSpatialDocWithImage('only-by-null-version'))
    await seedFile(WS_NULLVER, 'only-by-null-version', '.png', 55)
    await seedFile(WS_NULLVER, 'really-dangling-3', '.png', 11)

    const fakeStore = {
      listIdsByDocument: async () => ['v-missing'],
      openCheckouts: async () => ({ load: async () => null }),
    }

    await expect(
      purgeDanglingFiles(WS_NULLVER, { versionStore: fakeStore, graceMs: 0 }),
    ).rejects.toBeInstanceOf(IncompleteFileGcScanError)

    const remaining = (
      await readdir(workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, WS_NULLVER))
    ).sort()
    expect(remaining).toEqual(['only-by-null-version.png', 'really-dangling-3.png'])
  })
})

describe('purgeDanglingFiles: what a live document draws or can bring back', () => {
  async function remainingFiles(workspaceId: string): Promise<string[]> {
    return (await readdir(workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, workspaceId))).sort()
  }

  it('keeps an image a frame draws as its background', async () => {
    await saveDocument(
      WS_BG,
      'page',
      makeSpatialDoc({
        nodes: [
          groupNode({
            id: 'frame1',
            x: 0,
            y: 0,
            width: 300,
            height: 200,
            label: 'F',
            background: newImageRef('bg-1'),
            backgroundStyle: 'cover',
          }),
        ],
        edges: [],
      }),
    )
    await seedFile(WS_BG, 'bg-1', '.png', 700)

    const result = await purgeDanglingFiles(WS_BG, withVersions())

    expect(result.purgedCount).toBe(0)
    expect(await remainingFiles(WS_BG)).toEqual(['bg-1.png'])
  })

  it('keeps an image only a markdown document body embeds', async () => {
    const doc = new LoroDoc()
    doc.getText('body').insert(0, 'a ![p](asset:md-1) b')
    doc.commit()
    await saveDocument(WS_MD, 'note', doc, { kind: 'markdown' })
    await seedFile(WS_MD, 'md-1', '.png', 300)

    const result = await purgeDanglingFiles(WS_MD, withVersions())

    expect(result.purgedCount).toBe(0)
    expect(await remainingFiles(WS_MD)).toEqual(['md-1.png'])
  })

  it('keeps an image only a trashed document references, so a restore finds it', async () => {
    const { deleteDocument } = await import('./document-store.js')
    await saveDocument(WS_TRASH, 'page', makeSpatialDocWithImage('asset-t'))
    await seedFile(WS_TRASH, 'asset-t', '.png', 500)
    await deleteDocument(WS_TRASH, 'page')
    expect(await listDocuments(WS_TRASH)).toEqual([])

    const result = await purgeDanglingFiles(WS_TRASH, withVersions())

    expect(result.purgedCount).toBe(0)
    expect(await remainingFiles(WS_TRASH)).toEqual(['asset-t.png'])
  })

  // A trash row can outlive its bytes' delete — a purge that unlinked them,
  // deferred by a backup, then failed to save the row. GC reads the bytes
  // through the daemon's store, so its verdict is the one a pass would reach
  // had no backup been running: the bytes are gone.
  it('reads a trash entry whose delete a backup deferred as already gone', async () => {
    const { deleteDocument, openWorkspaceDocIfStored } = await import('./document-store.js')
    const { globalStoreScope } = await import('./store-scope.js')
    const { readTrashEntries } = await import('@kamiazya/whiteboard-loro-adapter')
    const { daemonBlobStore } = await import('./backup-guarded-blob-store.js')
    await saveDocument(WS_DEFERRED, 'page', makeSpatialDocWithImage('asset-d'))
    await seedFile(WS_DEFERRED, 'asset-d', '.png', 500)
    await deleteDocument(WS_DEFERRED, 'page')
    const record = await openWorkspaceDocIfStored(WS_DEFERRED, globalStoreScope)
    const [entry] = readTrashEntries(record ?? new LoroDoc())
    if (entry === undefined) throw new Error('the delete left no trash entry')
    const blobs = daemonBlobStore(tempDir, SELF_HOST_TENANT_ID)
    await withBackupMarker(tempDir, () => blobs.delete({ ref: entry.blob }))

    const result = await purgeDanglingFiles(WS_DEFERRED, withVersions())

    expect(result.purgedCount).toBe(1)
    expect(await remainingFiles(WS_DEFERRED)).toEqual([])
  })

  it('collects an image only a permanently deleted document referenced', async () => {
    const { deleteDocument, workspaceTreeIndex, resolveDocumentIdAtPath } = await import(
      './document-store.js'
    )
    const { globalStoreScope } = await import('./store-scope.js')
    await saveDocument(WS_PURGED, 'page', makeSpatialDocWithImage('asset-p'))
    await saveDocument(WS_PURGED, 'other', makeSpatialDocWithImage('asset-o'))
    await seedFile(WS_PURGED, 'asset-p', '.png', 500)
    await seedFile(WS_PURGED, 'asset-o', '.png', 700)
    const documentId = await resolveDocumentIdAtPath(WS_PURGED, 'page')
    await deleteDocument(WS_PURGED, 'page')
    expect((await purgeDanglingFiles(WS_PURGED, withVersions())).purgedCount).toBe(0)

    const index = await workspaceTreeIndex(globalStoreScope)
    expect(
      await index.purgeTrashEntry({ workspaceId: WS_PURGED, documentId: documentId ?? '' }),
    ).toBe(true)
    const result = await purgeDanglingFiles(WS_PURGED, withVersions())

    expect(result.purgedCount).toBe(1)
    expect(result.purgedBytes).toBe(500)
    // Only the purged document's image: a live document's is still referenced.
    expect(await remainingFiles(WS_PURGED)).toEqual(['asset-o.png'])
  })

  const unreadable: Record<string, (doc: LoroDoc) => void> = {
    'a folder carrying a key this build does not know': (doc) => {
      for (const node of doc.getTree('tree').getNodes()) {
        if ((node.data.toJSON() as { segment?: string }).segment === 'folder') {
          node.data.set('icon', 'folder-open')
        }
      }
    },
    'a document of a kind this build lacks': (doc) => {
      for (const node of doc.getTree('tree').getNodes()) {
        if ((node.data.toJSON() as { segment?: string }).segment === 'page') {
          node.data.set('kind', 'future-kind')
        }
      }
    },
  }
  for (const [name, tamper] of Object.entries(unreadable)) {
    it(`refuses to purge when ${name} hides a subtree`, async () => {
      const documentId = '01HZZZZZZZZZZZZZZZZZZZZZZZ'
      const docs = new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(handle.db))
      const workspaceDoc = (await docs.open(WS_UNREADABLE)) ?? new LoroDoc()
      createWorkspaceDocumentAtPath(workspaceDoc, {
        path: 'folder/page',
        documentId,
        kind: 'spatial',
      })
      writeWorkspaceDocumentContent(workspaceDoc, documentId, makeSpatialDocWithImage('asset-x'))
      tamper(workspaceDoc)
      workspaceDoc.commit()
      await docs.save(WS_UNREADABLE, workspaceDoc)
      await seedFile(WS_UNREADABLE, 'asset-x', '.png', 500)

      await expect(purgeDanglingFiles(WS_UNREADABLE, withVersions())).rejects.toBeInstanceOf(
        IncompleteFileGcScanError,
      )
      expect(await remainingFiles(WS_UNREADABLE)).toEqual(['asset-x.png'])
    })
  }
})

/**
 * ADR-0020. GC judges "referenced" from `openWorkspaceDocIfStored`, which
 * answers the cached workspace document, and a cache that trusted itself was
 * authoritative only while one
 * process wrote: a pass on instance A could not see a document instance B
 * created, and unlinked B's blobs as dangling, for as long as nothing caught
 * A up. The cache now follows the record on every access, so the view a pass
 * judges from is current; the explicit catch-up the pass takes first is what
 * covers the writes a read-through cannot, because it reads the log rather
 * than trusting a stamp.
 */
describe('purgeDanglingFiles across instances', () => {
  it('does not delete a blob referenced only by another instance', async () => {
    const workspaceId = GC_OTHER_INSTANCE
    // This instance's own document, so the workspace record and its cache
    // both exist before the other instance writes.
    await saveDocument(workspaceId, 'mine', makeSpatialDoc({ nodes: [], edges: [] }))
    await seedFile(workspaceId, 'theirs', '.png', 64)

    await writeFromOtherInstance(
      workspaceId,
      'theirs',
      '01ARZ3NDEKTSV4RRFFQ69G5FB9',
      makeSpatialDocWithImage('theirs'),
    )

    // The view a pass judges from has followed the record, so the document
    // that references the blob is in it.
    expect((await listDocuments(workspaceId)).map((entry) => entry.path)).toContain('theirs')

    await purgeDanglingFiles(workspaceId, withVersions({ graceMs: 0 }))
    expect(await readdir(workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, workspaceId))).toContain(
      'theirs.png',
    )
  })

  it('still deletes a blob nothing references, after catching up', async () => {
    const workspaceId = GC_OTHER_INSTANCE_DANGLING
    await saveDocument(workspaceId, 'mine', makeSpatialDoc({ nodes: [], edges: [] }))
    await seedFile(workspaceId, 'orphan', '.png', 64)

    await writeFromOtherInstance(
      workspaceId,
      'theirs',
      '01ARZ3NDEKTSV4RRFFQ69G5FBA',
      makeSpatialDoc({ nodes: [], edges: [] }),
    )

    const result = await purgeDanglingFiles(workspaceId, withVersions({ graceMs: 0 }))
    expect(result.purgedCount).toBe(1)
    expect(
      await readdir(workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, workspaceId)),
    ).not.toContain('orphan.png')
  })
})

/**
 * The FENCE, which the catch-up above does not cover.
 *
 * Catching up first fixes what this instance can SEE; it does nothing about a
 * write that lands while the pass is deciding. Collecting forks and checks
 * out every version of every document, so it is the longest window
 * in the pass and the one another instance is most likely to write into — and
 * a referenced set computed against a record that no longer exists must not
 * be acted on.
 *
 * The write is injected through the version store the collect already calls,
 * because that is the one seam inside the window. Without a case that reaches
 * it, removing the fence entirely leaves every other test in this file green
 * — measured.
 */
it('stands down when another instance writes while the pass is deciding', async () => {
  const workspaceId = GC_RECORD_MOVED
  await saveDocument(workspaceId, 'mine', makeSpatialDocWithImage('kept'))
  await seedFile(workspaceId, 'kept', '.png', 64)
  await seedFile(workspaceId, 'orphan', '.png', 64)

  let wrote = false
  const versionStore = {
    listIdsByDocument: async () => {
      // Inside the collect, exactly once: the window the fence exists for.
      if (!wrote) {
        wrote = true
        await writeFromOtherInstance(
          workspaceId,
          'theirs',
          '01ARZ3NDEKTSV4RRFFQ69G5FBB',
          makeSpatialDoc({ nodes: [], edges: [] }),
        )
      }
      return []
    },
    openCheckouts: async () => ({ load: async () => null }),
  }

  const result = await purgeDanglingFiles(workspaceId, {
    graceMs: 0,
    versionStore,
  })
  expect(wrote).toBe(true)
  expect(result.skippedReason).toBe('record-moved')
  expect(result.purgedCount).toBe(0)
  // Nothing was unlinked — not even the file that really was dangling. A
  // stood-down pass acts on nothing, and the next pass decides again.
  const files = await readdir(workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, workspaceId))
  expect(files).toContain('orphan.png')
  expect(files).toContain('kept.png')
})

/**
 * A backup being assembled is a reason to stand down.
 *
 * A backup captures the rows as a snapshot and the uploads as a directory
 * copy — two moments. A pass that unlinks between them removes a file the
 * snapshot still references, and the backup restores to a document pointing
 * at nothing, silently, because every step reported success. That is
 * ADR-0021 decision 6's far end in the shape this system has today.
 *
 * Checked FIRST, before the listing and the reference collect: the whole
 * point is to do no work and touch nothing while a backup reads the tree.
 */
it('stands down while a backup is assembling this data directory', async () => {
  const workspaceId = GC_BACKUP_RUNNING
  await saveDocument(workspaceId, 'mine', makeSpatialDocWithImage('kept'))
  await seedFile(workspaceId, 'kept', '.png', 64)
  await seedFile(workspaceId, 'orphan', '.png', 64)

  const result = await withBackupMarker(tempDir, () =>
    purgeDanglingFiles(workspaceId, withVersions({ graceMs: 0 })),
  )

  expect(result.skippedReason).toBe('backup-in-progress')
  expect(result.purgedCount).toBe(0)
  // Nothing unlinked — not even the file that really was dangling.
  const files = await readdir(workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, workspaceId))
  expect(files).toContain('orphan.png')
  expect(files).toContain('kept.png')
})

it('collects again once the backup has finished', async () => {
  const workspaceId = GC_BACKUP_FINISHED
  await saveDocument(workspaceId, 'mine', makeSpatialDocWithImage('kept'))
  await seedFile(workspaceId, 'kept', '.png', 64)
  await seedFile(workspaceId, 'orphan', '.png', 64)

  await withBackupMarker(tempDir, async () => {})
  const result = await purgeDanglingFiles(workspaceId, withVersions({ graceMs: 0 }))

  expect(result.skippedReason).toBeUndefined()
  expect(result.purgedCount).toBe(1)
  const files = await readdir(workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, workspaceId))
  expect(files).not.toContain('orphan.png')
  expect(files).toContain('kept.png')
})
