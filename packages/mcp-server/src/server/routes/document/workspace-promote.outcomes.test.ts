/**
 * Every outcome of a promote a caller can see, over the daemon's own route:
 * what a clean one leaves in an empty and in a populated workspace, what each
 * refusal answers, what a follower of the target hears, and that a refusal
 * leaves the target as it was, byte for byte.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  promoteJudgedBudgetRefusalSchema,
  promoteWorkspaceResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceNodeAtPath,
  documentContainers,
  exportWorkspaceSubtree,
  readMarkdownBody,
  recordTrashEntry,
  resolveWorkspaceDocument,
  writeMarkdownBody,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import { MARKDOWN_MAX_CHARS, NODE_TEXT_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import type * as versionEntry from '@kamiazya/whiteboard-server-core/versions/version-entry'
import { encodeFrontiers, LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolveTestServerDeps,
  seedWorkspaceRow,
  testDocumentRouterOptions,
} from '../_test-helpers.js'

let tempDir: string
let serverDeps: ServerDeps
let judgedBudget: number | undefined
vi.mock('@kamiazya/whiteboard-server-core/versions/version-entry', async (importOriginal) => {
  const real = await importOriginal<typeof versionEntry>()
  return {
    ...real,
    get PROMOTE_MAX_JUDGED_SIZE() {
      return judgedBudget ?? real.PROMOTE_MAX_JUDGED_SIZE
    },
  }
})
vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createDocumentRouter } = await import('../document.js')
const { clearDocCacheForTests } = await import('../../store/doc-cache.js')
const { _clearWorkspaceDocCacheForTests, onWorkspaceDocUpdated } = await import(
  '../../store/document-store.js'
)
const { createIsolatedDb } = await import('../../store/db/test-helpers.js')
await import('../../sync-audience.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'promote-outcomes-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearDocCacheForTests()
  _clearWorkspaceDocCacheForTests()
  await seedWorkspaceRow(tempDir, WS)
  serverDeps = await resolveTestServerDeps(tempDir)
})
afterEach(async () => {
  judgedBudget = undefined
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

const WS = '01M8BBN7JS60N0ZAR13NP8SXBF'
const ROADMAP_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const SKETCH_ID = '01BRWAAAAAAAAAAAAAAAAAAAA1'
const GONE_ID = '01BRWAAAAAAAAAAAAAAAAAAAA2'
const CONTESTED_ID = '01BRWAAAAAAAAAAAAAAAAAAAA3'
const OTHER_ID = '01BRWAAAAAAAAAAAAAAAAAAAA4'
const VERSION_ID = '01BRWVERSAAAAAAAAAAAAAAAA0'
// The largest peer id loses a contested path to any other, which makes the
// record's document the shadowed one without depending on the daemon's peer.
const LOSING_PEER = 18446744073709551614n

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
const snapshotOf = (doc: LoroDoc) => new Uint8Array(doc.export({ mode: 'snapshot' }))

interface PromoteBody {
  readonly snapshot: string
  readonly trash: { documentId: string; bytes: string }[]
  readonly versions: CarriedRow[]
}
type CarriedRow = {
  id: string
  documentId: string
  createdAt: number
  auto: boolean
  label?: string
  frontiers: string
}

/** A browser record: a note with a saved version, a canvas, a contested path and one trashed note. */
function browserRecord(peer = LOSING_PEER): PromoteBody {
  const doc = new LoroDoc()
  doc.setPeerId(peer)
  createWorkspaceDocumentAtPath(doc, {
    path: 'contested',
    documentId: CONTESTED_ID,
    kind: 'markdown',
  })
  createWorkspaceDocumentAtPath(doc, {
    path: 'notes/roadmap',
    documentId: ROADMAP_ID,
    kind: 'markdown',
    name: 'Roadmap',
  })
  writeMarkdownBody(documentContainers(doc, ROADMAP_ID), '# as drafted')
  doc.commit()
  const drafted = encodeFrontiers(doc.oplogFrontiers())
  writeMarkdownBody(documentContainers(doc, ROADMAP_ID), '# after the meeting')
  createWorkspaceDocumentAtPath(doc, { path: 'sketch', documentId: SKETCH_ID, kind: 'spatial' })
  createWorkspaceDocumentAtPath(doc, { path: 'gone', documentId: GONE_ID, kind: 'markdown' })
  writeMarkdownBody(documentContainers(doc, GONE_ID), '# trashed in the browser')
  doc.commit()
  const evacuated = exportWorkspaceSubtree(doc, 'gone')
  if (evacuated === null) throw new Error('no subtree to evacuate')
  deleteWorkspaceNodeAtPath(doc, 'gone')
  recordTrashEntry(doc, {
    documentId: GONE_ID,
    path: 'gone',
    deletedAt: 1,
    blob: { algorithm: 'sha-256', digestHex: createHash('sha256').update(evacuated).digest('hex') },
  })
  doc.commit()
  return {
    snapshot: b64u(snapshotOf(doc)),
    trash: [{ documentId: GONE_ID, bytes: b64u(evacuated) }],
    versions: [
      {
        id: VERSION_ID,
        documentId: ROADMAP_ID,
        createdAt: 1_000,
        auto: false,
        label: 'as drafted',
        frontiers: b64u(drafted),
      },
    ],
  }
}

/** A record of one canvas that a second promote carries, after the first has populated the target. */
function canvasRecord(mutate: (containers: ReturnType<typeof documentContainers>) => void) {
  const doc = new LoroDoc()
  doc.setPeerId(3n)
  createWorkspaceDocumentAtPath(doc, { path: 'other', documentId: OTHER_ID, kind: 'spatial' })
  mutate(documentContainers(doc, OTHER_ID))
  doc.commit()
  return { snapshot: b64u(snapshotOf(doc)) }
}

function harness() {
  const app = createDocumentRouter(
    testDocumentRouterOptions({ serverDeps, autoVersionQuietMs: 60_000 }),
  )
  const promote = (body: unknown) =>
    app.request(`/api/w/${WS}/workspace-document/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const snapshotBytes = async () =>
    new Uint8Array(
      await (await app.request(`/api/w/${WS}/workspace-document/snapshot`)).arrayBuffer(),
    )
  /** Everything a caller can read of the workspace, as one comparable value. */
  const held = async () => {
    const documents = await serverDeps.documentIndex.listDocuments({ workspaceId: WS })
    const versions: Record<string, unknown> = {}
    for (const entry of documents) {
      versions[entry.path] = await serverDeps.versions.list(WS, entry.path)
    }
    const trash = await (await app.request(`/api/workspaces/${WS}/trash`)).json()
    return {
      record: createHash('sha256')
        .update(await snapshotBytes())
        .digest('hex'),
      documents: documents.map((entry) => [entry.path, entry.documentId, entry.contentDigest]),
      versions,
      trash,
    }
  }
  return { app, promote, held, snapshotBytes }
}

describe('a clean promote', () => {
  it('into an empty workspace leaves the documents, names, versions and trash it carried', async () => {
    const { promote, held } = harness()
    const res = await promote(browserRecord(2n))
    expect(res.status).toBe(200)
    const answer = promoteWorkspaceResponseSchema.parse(await res.json())
    expect([...answer.recorded].sort()).toEqual([ROADMAP_ID, SKETCH_ID, CONTESTED_ID].sort())
    expect(answer.shadowed).toEqual([])
    expect(answer.trashStored).toEqual([GONE_ID])
    expect(answer.versionsKept).toEqual([VERSION_ID])

    const state = await held()
    expect(state.documents.map(([path]) => path)).toEqual(['contested', 'notes/roadmap', 'sketch'])
    const roadmap = await serverDeps.documentIndex.resolveDocument({
      workspaceId: WS,
      path: 'notes/roadmap',
    })
    expect(roadmap?.name).toBe('Roadmap')
    const rows = state.versions['notes/roadmap'] as { id: string; auto: boolean; label?: string }[]
    expect(rows.map((row) => [row.id, row.auto, row.label])).toEqual(
      expect.arrayContaining([[VERSION_ID, false, 'as drafted']]),
    )
    // The explicit checkpoint a promote takes beside the carried one.
    expect(rows.filter((row) => row.auto === false)).toHaveLength(2)
    expect((state.versions.sketch as unknown[]).length).toBe(1)
    expect(JSON.stringify(state.trash)).toContain(GONE_ID)
    const record = LoroDoc.fromSnapshot(await harness().snapshotBytes())
    expect(readMarkdownBody(documentContainers(record, ROADMAP_ID))).toBe('# after the meeting')
  })

  it('into a populated workspace shadows the contested path and keeps what the target held', async () => {
    const { promote, held } = harness()
    await serverDeps.documentIndex.createDocument({
      workspaceId: WS,
      path: 'contested',
      kind: 'markdown',
    })
    const before = await held()
    const own = before.documents.find(([path]) => path === 'contested')
    const ownId = own?.[1]

    const res = await promote(browserRecord())
    expect(res.status).toBe(200)
    const answer = promoteWorkspaceResponseSchema.parse(await res.json())
    expect(answer.shadowed).toEqual([CONTESTED_ID])
    expect([...answer.recorded].sort()).toEqual([ROADMAP_ID, SKETCH_ID])
    const after = await held()
    // The shadowed document stays in the record beside the one that won the path.
    expect(after.documents.find(([, id]) => id === ownId)).toEqual(own)
    expect(after.documents.map(([path]) => path)).toEqual([
      'contested',
      'contested',
      'notes/roadmap',
      'sketch',
    ])
    expect(after.versions.contested).toEqual(before.versions.contested)
  })

  it('answers the same on a re-run and leaves one row per carried version', async () => {
    const { promote, held } = harness()
    const record = browserRecord(2n)
    await promote(record)
    const once = await held()
    const res = await promote(record)
    expect(res.status).toBe(200)
    const again = await held()
    const carried = (state: typeof once) =>
      (state.versions['notes/roadmap'] as { id: string }[]).filter((row) => row.id === VERSION_ID)
    expect(carried(again)).toHaveLength(1)
    expect(again.documents).toEqual(once.documents)
  })
})

describe('the target workspace as a follower of it sees a promote', () => {
  it('is handed the promoted documents through the announced updates', async () => {
    const { promote, snapshotBytes } = harness()
    await promote(browserRecord(2n))
    const follower = LoroDoc.fromSnapshot(await snapshotBytes())
    const heard: Uint8Array[] = []
    const stop = onWorkspaceDocUpdated((workspaceId, update) => {
      if (workspaceId === WS) heard.push(update)
    })
    const res = await promote(canvasRecord((c) => c.getMap('nodes').size))
    stop()
    expect(res.status).toBe(200)
    expect(heard.length).toBeGreaterThan(0)
    for (const update of heard) follower.import(update)
    expect(resolveWorkspaceDocument(follower, 'other')?.documentId).toBe(OTHER_ID)
    const record = LoroDoc.fromSnapshot(await snapshotBytes())
    expect(follower.oplogVersion().toJSON()).toEqual(record.oplogVersion().toJSON())
  })
})

const stranger = (() => {
  const doc = new LoroDoc()
  doc.setPeerId(9n)
  doc.getText('t').insert(0, 'elsewhere')
  doc.commit()
  return b64u(encodeFrontiers(doc.oplogFrontiers()))
})()

const oversizedNote = (): LoroDoc => {
  const doc = new LoroDoc()
  doc.setPeerId(4n)
  createWorkspaceDocumentAtPath(doc, { path: 'notes/long', documentId: OTHER_ID, kind: 'markdown' })
  const body = documentContainers(doc, OTHER_ID)
  const half = Math.ceil((MARKDOWN_MAX_CHARS + 1) / 2)
  writeMarkdownBody(body, 'a'.repeat(half))
  writeMarkdownBody(body, 'b'.repeat(half) + 'a'.repeat(half))
  return doc
}

interface Refusal {
  readonly status: number
  readonly error: string
  readonly message: string | RegExp
}

const refusals: readonly [string, () => unknown, Refusal][] = [
  [
    'a text limit, naming the document',
    () =>
      canvasRecord((c) =>
        writeSpatialNode(
          c,
          textNode({
            id: 'big',
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            text: 'x'.repeat(NODE_TEXT_MAX_CHARS + 1),
          }),
        ),
      ),
    { status: 413, error: 'node_text_too_large', message: /^The document at "other" / },
  ],
  [
    'a retired stored shape',
    () =>
      canvasRecord((c) => c.getMap('nodes').set('old', { id: 'old', 'x-whiteboard': { a: 1 } })),
    { status: 400, error: 'retired_stored_shape', message: /x-whiteboard/ },
  ],
  [
    'the retired comments plane',
    () => canvasRecord((c) => c.getMap('comments').set('c1', { id: 'c1' })),
    { status: 400, error: 'retired_comment_plane', message: /./ },
  ],
  [
    'bytes that are not a record',
    () => ({ snapshot: b64u(new Uint8Array([1, 2, 3, 4])) }),
    { status: 400, error: 'malformed_snapshot', message: 'Malformed workspace record snapshot' },
  ],
  [
    'a version whose point the record lacks',
    () => ({
      ...browserRecord(2n),
      versions: [{ ...browserRecord(2n).versions[0], frontiers: stranger }],
    }),
    {
      status: 400,
      error: 'unmatched_carried',
      message: `Version "${VERSION_ID}" names a point the record does not hold.`,
    },
  ],
  [
    'a version naming a document the record did not hold then',
    () => ({
      ...browserRecord(2n),
      versions: [{ ...browserRecord(2n).versions[0], documentId: GONE_ID }],
    }),
    { status: 400, error: 'unmatched_carried', message: /./ },
  ],
  [
    'trash bytes that are not what the entry names',
    () => ({
      ...browserRecord(2n),
      trash: [{ documentId: GONE_ID, bytes: b64u(new Uint8Array([9, 9, 9])) }],
    }),
    { status: 400, error: 'unmatched_carried', message: /not the ones its trash entry names/ },
  ],
  [
    'trash for a document the record has no entry for',
    () => ({
      ...browserRecord(2n),
      trash: [{ documentId: ROADMAP_ID, bytes: b64u(new Uint8Array([9])) }],
    }),
    { status: 400, error: 'unmatched_carried', message: /No trash entry in the record/ },
  ],
  [
    'a carried version past the markdown limit',
    () => {
      const doc = oversizedNote()
      const oversized = encodeFrontiers(doc.oplogFrontiers())
      writeMarkdownBody(documentContainers(doc, OTHER_ID), '# short again')
      return {
        snapshot: b64u(snapshotOf(doc)),
        versions: [
          {
            id: VERSION_ID,
            documentId: OTHER_ID,
            createdAt: 1,
            auto: false,
            frontiers: b64u(oversized),
          },
        ],
      }
    },
    { status: 413, error: 'markdown_too_large', message: /^The document at "notes\/long" / },
  ],
]

describe('a refused promote into a populated workspace', () => {
  it.each(
    refusals,
  )('answers %s and leaves the target byte for byte as it was', async (_name, body, expected) => {
    const { promote, held, snapshotBytes } = harness()
    expect((await promote(browserRecordForTarget())).status).toBe(200)
    const before = await held()
    const bytesBefore = await snapshotBytes()
    const heard: Uint8Array[] = []
    const stop = onWorkspaceDocUpdated((workspaceId, update) => {
      if (workspaceId === WS) heard.push(update)
    })

    const res = await promote(body())
    stop()

    expect(res.status).toBe(expected.status)
    const answered = (await res.json()) as { error: string; message: string }
    expect(answered.error).toBe(expected.error)
    if (typeof expected.message === 'string') expect(answered.message).toBe(expected.message)
    else expect(answered.message).toMatch(expected.message)
    expect(await held()).toEqual(before)
    expect(Buffer.from(await snapshotBytes()).equals(Buffer.from(bytesBefore))).toBe(true)
    expect(heard).toEqual([])
  })

  it('answers a judged-size refusal under its own code and leaves the target as it was', async () => {
    const { promote, held } = harness()
    expect((await promote(browserRecordForTarget())).status).toBe(200)
    const before = await held()
    judgedBudget = 1
    const record = browserRecord(2n)
    const res = await promote({ ...record, snapshot: record.snapshot })
    expect(res.status).toBe(413)
    const refusal = promoteJudgedBudgetRefusalSchema.parse(await res.json())
    expect(refusal.error).toBe('promote_too_many_carried')
    expect(refusal.limit).toBe(1)
    expect(refusal.message).toContain('at most 1 characters')
    expect(await held()).toEqual(before)
  })
})

/** What the target already holds before a refused promote: one canvas with a version and a trashed note. */
function browserRecordForTarget() {
  const doc = new LoroDoc()
  doc.setPeerId(5n)
  createWorkspaceDocumentAtPath(doc, {
    path: 'held',
    documentId: '01BRWAAAAAAAAAAAAAAAAAAAB0',
    kind: 'markdown',
  })
  writeMarkdownBody(documentContainers(doc, '01BRWAAAAAAAAAAAAAAAAAAAB0'), '# held')
  doc.commit()
  return { snapshot: b64u(snapshotOf(doc)) }
}
