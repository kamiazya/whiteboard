// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: a recorder lists a corpus case by case; its branches are cases, not logic
/**
 * Records `src/oracle/index-rules.jsonl`: what the workspace index's rules
 * answer today. Two kinds of row. A pure row is a rule over plain values (the
 * first free segment, a move's collision, a display name's taking, the entry a
 * port answers, a trash row's restorability). An index row is one operation of
 * `LoroWorkspaceDocumentIndex` over a workspace record held as an engine lease:
 * the record's snapshot and the blobs before, the call and its arguments, the
 * answer or the class of its refusal, and what the keeper stored after.
 *
 *   pnpm --filter @kamiazya/whiteboard-mcp exec tsx \
 *     ../workspace-index/scripts/record-index-oracle.ts
 *
 * Every random choice comes from a seeded generator, the clock and the minted
 * ids are pinned (`pinned`), and the record writes as peer 1, so a re-run under
 * the same loro-crdt writes the same answers. The one thing a re-run changes is
 * the bytes of an exported subtree (`restorableTrashDocuments` rows, and the
 * blobs a restore row starts from): loro-adapter exports one through a document
 * under a random peer, and no answer depends on it. The recording is the oracle for the
 * Rust `whiteboard-workspace-index` crate: re-take it only deliberately.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceNodeAtPath,
  exportWorkspaceSubtree,
  loadCrdtEngine,
  pruneEmptyFolders,
  readWorkspaceDocuments,
  readWorkspaceNodes,
  recordTrashEntry,
  setWorkspaceFolderName,
  setWorkspacePinned,
  type WorkspaceNode,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  bytesToBase64,
  generateDocumentId,
  WORKSPACE_SEGMENT_MAX_LENGTH,
} from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import {
  type BlobRow,
  blobSummary,
  type IndexRow,
  type PureRow,
  pinned,
  replayIndex,
  replayPure,
  WORKSPACE_ID,
} from '../src/test-utils/index-oracle.js'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', 'src', 'oracle', 'index-rules.jsonl')

type Rng = () => number
function rngOf(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1))
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T
const b64 = (bytes: Uint8Array) => bytesToBase64(bytes)

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const docId = (n: number) =>
  `01ARZ3NDEKTSV4RRFFQ69G5F${CROCKFORD[(n >> 5) & 31]}${CROCKFORD[n & 31]}`.slice(0, 26)

/** Names a person writes: case and whitespace variants, CJK, emoji, a ZWJ family, composed and decomposed accents. */
const NAMES = [
  'Plan',
  'plan',
  'PLAN',
  'Plan ',
  ' plan',
  '日本語',
  '日本語 ',
  '😀',
  '👩‍👩‍👧',
  'é',
  'é',
  'Résumé',
  'Notes',
  'Untitled',
  'untitled',
  'a',
]
const SEGMENTS = ['a', 'b', 'c', 'notes', 'plan', 'x-1', 'draft', 'untitled']

const rows: Array<Record<string, unknown>> = []
const push = (row: Record<string, unknown>) => rows.push({ id: `${row.op}-${rows.length}`, ...row })

// ---- scenes: a workspace record, as bytes ----

interface Scene {
  doc: LoroDoc
  nodes: WorkspaceNode[]
  documents: Array<{ documentId: string; path: string }>
}

function sceneOf(doc: LoroDoc): Scene {
  return {
    doc,
    nodes: readWorkspaceNodes(doc),
    documents: readWorkspaceDocuments(doc).map(({ documentId, path }) => ({ documentId, path })),
  }
}

function buildScene(seed: number, merged: boolean): Scene {
  const rng = rngOf(seed)
  const doc = new LoroDoc()
  doc.setPeerId(1n)
  const made: Array<{ id: string; path: string }> = []
  const count = int(rng, 3, 6)
  for (let k = 0; k < count; k++) {
    const path =
      made.length > 0 && rng() < 0.35
        ? `${pick(rng, made).path}/${pick(rng, SEGMENTS)}`
        : Array.from({ length: int(rng, 1, 3) }, () => pick(rng, SEGMENTS)).join('/')
    const id = docId(seed * 8 + k)
    try {
      const created = createWorkspaceDocumentAtPath(doc, {
        path,
        documentId: id,
        kind: rng() < 0.3 ? 'spatial' : 'markdown',
        createdAt: 1000 + k,
        updatedAt: 2000 + k,
        ...(rng() < 0.6 ? { name: pick(rng, NAMES) } : {}),
      })
      if (created !== null) made.push({ id, path })
    } catch {
      // a path the tree does not place is a shape the scene skips
    }
  }
  for (const node of readWorkspaceNodes(doc)) {
    if (node.type === 'folder' && rng() < 0.5) {
      setWorkspaceFolderName(doc, { path: node.path, name: pick(rng, NAMES) })
    }
  }
  for (const entry of made) if (rng() < 0.3) setWorkspacePinned(doc, entry.id, true)
  if (merged) {
    // two replicas that each made a document at one path: the merge keeps both
    const at = made.length > 0 ? `${(pick(rng, made) as { path: string }).path}/twin` : 'twin'
    const replica = LoroDoc.fromSnapshot(doc.export({ mode: 'snapshot' }))
    replica.setPeerId(2n)
    const twin = (target: LoroDoc, n: number) =>
      createWorkspaceDocumentAtPath(target, {
        path: at,
        documentId: docId(seed * 8 + n),
        kind: 'markdown',
        createdAt: 1500 + n,
        updatedAt: 1500 + n,
      })
    twin(doc, 6)
    twin(replica, 7)
    doc.import(replica.export({ mode: 'update' }))
  }
  return sceneOf(doc)
}

const snapshot = (doc: LoroDoc) => b64(doc.export({ mode: 'snapshot' }))

// ---- pure rows ----

async function pure(tag: string, row: PureRow) {
  push({ op: row.op, tag, ...row, result: await replayPure(row) })
}

async function recordFirstFreeSegment() {
  const long = (n: number) => 'x'.repeat(n)
  const bases = ['plan', 'my-workspace', 'a', 'x-1', '01arz3ndekv4rrffq69g5fav']
  for (const base of bases) {
    await pure('free', { op: 'firstFreeSegment', base, taken: [] })
    await pure('base-taken', { op: 'firstFreeSegment', base, taken: [base] })
    await pure('second-taken', { op: 'firstFreeSegment', base, taken: [base, `${base}-2`] })
    await pure('gap', { op: 'firstFreeSegment', base, taken: [base, `${base}-3`] })
    await pure('only-suffix', { op: 'firstFreeSegment', base, taken: [`${base}-2`] })
    for (const through of [3, 10, 100, 998, 999, 1000, 1500]) {
      await pure(`through-${through}`, {
        op: 'firstFreeSegment',
        base,
        taken: [base],
        takenThrough: through,
      })
    }
  }
  // a suffix can push a long base out of the segment grammar
  const max = WORKSPACE_SEGMENT_MAX_LENGTH
  for (const length of [max - 3, max - 2, max - 1, max]) {
    const base = long(length)
    await pure(`long-${length}`, { op: 'firstFreeSegment', base, taken: [base] })
    await pure(`long-${length}-second`, {
      op: 'firstFreeSegment',
      base,
      taken: [base, `${base}-2`],
    })
  }
  await pure('empty-base', { op: 'firstFreeSegment', base: '', taken: [''] })
}

async function recordNameRules(scenes: Scene[]) {
  const names = [undefined, ...NAMES]
  for (const [i, current] of names.entries()) {
    for (const next of NAMES) {
      if ((i + NAMES.indexOf(next)) % 2 === 0) {
        await pure('pair', {
          op: 'sameDisplayName',
          ...(current === undefined ? {} : { current }),
          next,
        })
      }
    }
  }
  for (const [s, scene] of scenes.entries()) {
    const rng = rngOf(900 + s)
    const paths = scene.nodes.map((n) => n.path)
    const newPath = () =>
      Array.from({ length: int(rng, 1, 3) }, () => pick(rng, SEGMENTS)).join('/')
    for (let k = 0; k < 4; k++) {
      const path = k % 2 === 0 ? (pick(rng, paths) ?? 'a') : newPath()
      const documentId = k === 1 ? pick(rng, scene.documents)?.documentId : undefined
      await pure(`sibling-${k}`, {
        op: 'refuseSiblingDocumentName',
        nodes: scene.nodes,
        path,
        name: pick(rng, NAMES),
        ...(documentId === undefined ? {} : { documentId }),
      })
    }
    // a document keeping the name it shows is no duplicate of itself, and is one without its id
    for (const node of scene.nodes.slice(0, 6)) {
      if (node.type !== 'document' || node.meta.name === undefined) continue
      const own = {
        op: 'refuseSiblingDocumentName' as const,
        nodes: scene.nodes,
        path: node.path,
        name: node.meta.name,
      }
      await pure('own-name', { ...own, documentId: node.meta.documentId })
      await pure('own-name-no-id', own)
    }
    for (let k = 0; k < 5; k++) {
      const from = k === 4 ? 'missing' : (pick(rng, paths) ?? 'a')
      const to = [
        newPath(),
        pick(rng, paths) ?? 'a',
        `${from}/inner`,
        from.split('/').slice(0, -1).join('/') || 'a',
        newPath(),
      ][k] as string
      await pure(`move-${k}`, { op: 'moveCollision', nodes: scene.nodes, from, to })
      await pure(`moved-name-${k}`, { op: 'refuseMovedName', nodes: scene.nodes, from, to })
    }
    for (const path of [pick(rng, paths) ?? 'a', 'untitled', 'untitled-2', newPath()]) {
      await pure('unnamed', { op: 'distinctUnnamedPath', nodes: scene.nodes, path })
    }
  }
}

async function recordEntryRules(scenes: Scene[]) {
  for (const scene of scenes.slice(0, 8)) {
    for (const found of readWorkspaceDocuments(scene.doc)) {
      await pure('read', { op: 'entryOf', found: found as never })
    }
  }
  const base = { documentId: docId(1), path: 'a', contentDigest: 'd'.repeat(8) }
  const kinds = [undefined, 'markdown', 'spatial'] as const
  for (const kind of kinds) {
    for (const name of [undefined, '日本語']) {
      for (const stamps of [
        {},
        { createdAt: 1000 },
        { updatedAt: 2000 },
        { createdAt: 1000, updatedAt: 2000 },
        { createdAt: 0 },
      ]) {
        for (const shadowed of [undefined, true as const]) {
          await pure('shape', {
            op: 'entryOf',
            found: {
              ...base,
              ...(kind === undefined ? {} : { kind }),
              ...(name === undefined ? {} : { name }),
              ...(shadowed === undefined ? {} : { shadowed }),
              ...stamps,
            } as never,
          })
        }
      }
    }
  }
  const blob = (n: number) => ({
    algorithm: 'sha-256' as const,
    digestHex: String(n).padStart(64, '0'),
  })
  const trash = (id: number, blobN: number) => ({
    documentId: docId(id),
    path: `gone/${id}`,
    deletedAt: 100 + id,
    blob: blob(blobN),
  })
  const sets = [
    { rows: [], entry: trash(1, 1) },
    { rows: [trash(1, 1)], entry: trash(1, 1) },
    { rows: [trash(1, 1), trash(2, 1)], entry: trash(1, 1) },
    { rows: [trash(1, 1), trash(2, 2)], entry: trash(1, 1) },
    { rows: [trash(1, 1), trash(2, 2), trash(3, 1)], entry: trash(2, 2) },
    { rows: [trash(2, 1)], entry: trash(1, 1) },
  ]
  for (const set of sets) await pure('named', { op: 'isNamedByAnotherRow', ...set })
}

// ---- restorability over exported subtrees ----

async function recordRestorable(scenes: Scene[]) {
  for (const [s, scene] of scenes.entries()) {
    for (const node of scene.nodes.slice(0, 4)) {
      const bytes = exportWorkspaceSubtree(scene.doc, node.path)
      if (bytes === null) continue
      const own = node.type === 'document' ? node.meta.documentId : docId(900)
      const parents: Array<string | null> = [null, 'a', 'notes/b']
      for (const parentPath of parents) {
        await pure(`${node.type}-${s}`, {
          op: 'restorableTrashDocuments',
          bytes: b64(bytes),
          documentId: own,
          parentPath,
        })
      }
      await pure(`other-id-${s}`, {
        op: 'restorableTrashDocuments',
        bytes: b64(bytes),
        documentId: docId(901),
        parentPath: null,
      })
    }
  }
  const doc = new LoroDoc()
  doc.setPeerId(1n)
  const named = (length: number, id: number, path: string) =>
    createWorkspaceDocumentAtPath(doc, {
      path,
      documentId: docId(id),
      kind: 'markdown',
      name: 'n'.repeat(length),
      createdAt: 1,
      updatedAt: 1,
    })
  for (const [length, id] of [
    [200, 950],
    [201, 951],
    [0, 952],
  ] as const) {
    try {
      named(length, id, `bound/d${id}`)
    } catch {
      // a name past the bound is a record the writer refuses; the row is not made
    }
    const bytes = exportWorkspaceSubtree(doc, `bound/d${id}`)
    if (bytes === null) continue
    await pure(`name-${length}`, {
      op: 'restorableTrashDocuments',
      bytes: b64(bytes),
      documentId: docId(id),
      parentPath: 'bound',
    })
  }
  for (const bytes of [[], [0, 0, 0], [108, 111, 114, 111], Array(64).fill(255)]) {
    await pure('garbage', {
      op: 'restorableTrashDocuments',
      bytes: b64(Uint8Array.from(bytes)),
      documentId: docId(1),
      parentPath: null,
    })
  }
}

// ---- the index's operations ----

const prefix = async () => (await pinned([docId(0)], async () => generateDocumentId())).slice(0, 10)

interface Held {
  before: string | null
  blobs: BlobRow[]
}

let engine: Awaited<ReturnType<typeof loadCrdtEngine>>
async function index(tag: string, op: string, held: Held, args: object, rng: Rng) {
  const head = await prefix()
  const candidates = [0, 1].map(
    () => head + Array.from({ length: 16 }, () => CROCKFORD[int(rng, 0, 31)]).join(''),
  )
  const call: IndexRow = {
    op,
    before: held.before,
    blobs: held.blobs,
    args: { workspaceId: WORKSPACE_ID, ...args },
    mint: candidates,
  }
  const outcome = await replayIndex(call, engine)
  const mint = candidates.slice(0, outcome.minted)
  push({
    op,
    tag,
    before: held.before,
    blobs: held.blobs,
    args: call.args,
    mint,
    result: outcome.result,
    saves: outcome.saves,
    // an untouched record is its own before, so only a write carries its state
    ...(outcome.saves > 0 ? { deep: outcome.deep } : {}),
    vv: outcome.vv,
    blobsAfter: blobSummary(outcome.blobs),
  })
  return outcome
}

async function recordIndexOps(scenes: Scene[]) {
  await index('no-workspace', 'listDocuments', { before: null, blobs: [] }, {}, rngOf(1))
  await index(
    'no-workspace-create',
    'createDocument',
    { before: null, blobs: [] },
    { path: 'a', kind: 'markdown' },
    rngOf(2),
  )
  for (const [s, scene] of scenes.entries()) {
    const rng = rngOf(2000 + s)
    const held: Held = { before: snapshot(scene.doc), blobs: [] }
    const paths = scene.nodes.map((n) => n.path)
    const documents = scene.documents
    const folders = scene.nodes.filter((n) => n.type === 'folder')
    const newPath = () =>
      Array.from({ length: int(rng, 1, 3) }, () => pick(rng, SEGMENTS)).join('/')
    const doc = () => pick(rng, documents)
    const run = (tag: string, op: string, args: object) => index(tag, op, held, args, rng)

    for (const op of ['listDocuments', 'listFolderNames', 'listPinnedDocuments', 'listTrash']) {
      await run('read', op, {})
    }
    await run('path', 'resolveDocument', { path: doc()?.path ?? 'a' })
    await run('missing-path', 'resolveDocument', { path: 'nothing/here' })
    if (folders[0] !== undefined)
      await run('folder-path', 'resolveDocument', { path: folders[0].path })
    await run('id', 'resolveDocumentById', { documentId: doc()?.documentId ?? docId(0) })
    await run('missing-id', 'resolveDocumentById', { documentId: docId(990) })

    const contested = documents.find((d) => documents.filter((o) => o.path === d.path).length > 1)
    if (contested !== undefined) {
      await run('contested-resolve', 'resolveDocument', { path: contested.path })
      await run('contested-duplicate', 'duplicateDocument', { path: contested.path })
      await run('contested-create', 'createDocument', { path: contested.path, kind: 'markdown' })
    }
    await run('new-unnamed', 'createDocument', { path: newPath(), kind: 'markdown' })
    await run('new-named', 'createDocument', {
      path: newPath(),
      kind: 'spatial',
      name: pick(rng, NAMES),
    })
    await run('untitled', 'createDocument', { path: 'untitled', kind: 'markdown' })
    await run('owned-path', 'createDocument', { path: doc()?.path ?? 'a', kind: 'markdown' })
    await run('owned-path-named', 'createDocument', {
      path: doc()?.path ?? 'a',
      kind: 'markdown',
      name: 'Fresh',
    })
    if (folders[0] !== undefined) {
      await run('promote-folder', 'createDocument', { path: folders[0].path, kind: 'markdown' })
    }
    await run('twin-name', 'createDocument', {
      path: newPath(),
      kind: 'markdown',
      name: pick(rng, NAMES),
    })
    await run('bad-path', 'createDocument', { path: '/bad', kind: 'markdown' })
    await run('bad-segment', 'createDocument', { path: 'a b', kind: 'markdown' })

    const from = () => pick(rng, paths) ?? 'a'
    const f1 = from()
    await run('to-new', 'moveDocument', { from: f1, to: newPath() })
    await run('to-existing', 'moveDocument', { from: from(), to: pick(rng, paths) ?? 'a' })
    const f2 = from()
    await run('to-parent', 'moveDocument', {
      from: f2,
      to: f2.split('/').slice(0, -1).join('/') || 'a',
    })
    const f3 = from()
    await run('into-self', 'moveDocument', { from: f3, to: `${f3}/inner` })
    await run('missing-from', 'moveDocument', { from: 'nothing/here', to: 'elsewhere' })
    await run('bad-to', 'moveDocument', { from: from(), to: 'a//b' })
    await run('same-place', 'moveDocument', { from: f1, to: f1 })

    const named = (id: string) => {
      const node = scene.nodes.find((n) => n.type === 'document' && n.meta.documentId === id)
      return node?.type === 'document' ? node.meta.name : undefined
    }
    for (let k = 0; k < 2; k++) {
      const target = doc()
      if (target === undefined) continue
      await run('rename', 'setDocumentName', {
        documentId: target.documentId,
        name: pick(rng, NAMES),
      })
      const current = named(target.documentId)
      if (current !== undefined) {
        await run('rename-same', 'setDocumentName', {
          documentId: target.documentId,
          name: current,
        })
      }
    }
    const target = doc()
    if (target !== undefined) {
      await run('clear-blank', 'setDocumentName', { documentId: target.documentId, name: '  ' })
      await run('clear-absent', 'setDocumentName', { documentId: target.documentId })
      await run('too-long', 'setDocumentName', {
        documentId: target.documentId,
        name: 'n'.repeat(201),
      })
      await run('pin', 'setDocumentPinned', { documentId: target.documentId, pinned: true })
      await run('unpin', 'setDocumentPinned', { documentId: target.documentId, pinned: false })
      await run('duplicate', 'duplicateDocument', { path: target.path })
      await run('duplicate-bare', 'duplicateDocument', {
        path: target.path,
        withoutAnnotations: true,
      })
    }
    await run('rename-missing', 'setDocumentName', { documentId: docId(991), name: 'x' })
    await run('pin-missing', 'setDocumentPinned', { documentId: docId(991), pinned: true })
    await run('duplicate-missing', 'duplicateDocument', { path: 'nothing/here' })

    for (const folder of folders.slice(0, 2)) {
      await run('folder-name', 'setFolderName', { path: folder.path, name: pick(rng, NAMES) })
      await run('folder-name-clear', 'setFolderName', { path: folder.path })
    }
    await run('folder-missing', 'setFolderName', { path: 'nothing/here', name: 'x' })

    const leaf = documents.find((d) => !paths.some((p) => p.startsWith(`${d.path}/`)))
    if (leaf !== undefined) {
      const deleted = await run('delete-leaf', 'deleteDocument', { path: leaf.path })
      if (deleted.stored !== null && deleted.saves > 0) {
        const after: Held = { before: deleted.stored, blobs: deleted.blobs }
        const id = leaf.documentId
        await index('trash-list', 'listTrash', after, {}, rng)
        await index('restore', 'restoreDocument', after, { documentId: id }, rng)
        await index('purge', 'purgeTrashEntry', after, { documentId: id }, rng)
        await index('purge-absent', 'purgeTrashEntry', after, { documentId: docId(992) }, rng)
        await index('restore-absent', 'restoreDocument', after, { documentId: docId(992) }, rng)
        await index(
          'restore-blob-gone',
          'restoreDocument',
          { ...after, blobs: [] },
          { documentId: id },
          rng,
        )
        const first = deleted.blobs[0]
        if (first !== undefined) {
          await index(
            'restore-garbage-blob',
            'restoreDocument',
            {
              ...after,
              blobs: [{ digestHex: first.digestHex, bytes: b64(Uint8Array.of(0, 0, 0)) }],
            },
            { documentId: id },
            rng,
          )
          // another document's bytes under this row: the root is not the row's document
          const other = documents.find((d) => d.documentId !== id)
          const otherBytes =
            other === undefined ? null : exportWorkspaceSubtree(scene.doc, other.path)
          if (otherBytes !== null) {
            await index(
              'restore-wrong-bytes',
              'restoreDocument',
              { ...after, blobs: [{ digestHex: first.digestHex, bytes: b64(otherBytes) }] },
              { documentId: id },
              rng,
            )
          }
          // the path taken again before the restore
          const reoccupied = LoroDoc.fromSnapshot(
            Uint8Array.from(Buffer.from(deleted.stored, 'base64')),
          )
          reoccupied.setPeerId(3n)
          createWorkspaceDocumentAtPath(reoccupied, {
            path: leaf.path,
            documentId: docId(993),
            kind: 'markdown',
            createdAt: 3000,
            updatedAt: 3000,
          })
          await index(
            'restore-occupied',
            'restoreDocument',
            { blobs: deleted.blobs, before: snapshot(reoccupied) },
            { documentId: id },
            rng,
          )
        }
      }
    }
    await run('delete-missing', 'deleteDocument', { path: 'nothing/here' })
    const parent = documents.find((d) => paths.some((p) => p.startsWith(`${d.path}/`)))
    if (parent !== undefined)
      await run('delete-with-descendants', 'deleteDocument', { path: parent.path })
    if (folders[0] !== undefined)
      await run('delete-folder', 'deleteDocument', { path: folders[0].path })
  }

  // two trash rows naming one blob: either's restore or purge leaves the bytes for the other
  for (let i = 0; i < 4; i++) {
    const rng = rngOf(3000 + i)
    const scene = buildScene(400 + i, false)
    const [one, two] = scene.documents.filter(
      (d) => !scene.nodes.some((n) => n.path.startsWith(`${d.path}/`)),
    )
    if (one === undefined || two === undefined) continue
    const bytes = exportWorkspaceSubtree(scene.doc, one.path)
    if (bytes === null) continue
    const digestHex = '0'.repeat(63) + '9'
    const entry = (d: { documentId: string; path: string }, at: number) => ({
      documentId: d.documentId,
      path: d.path,
      deletedAt: at,
      blob: { algorithm: 'sha-256' as const, digestHex },
    })
    recordTrashEntry(scene.doc, entry(one, 100))
    recordTrashEntry(scene.doc, entry(two, 200))
    deleteWorkspaceNodeAtPath(scene.doc, one.path)
    pruneEmptyFolders(scene.doc)
    const held: Held = { before: snapshot(scene.doc), blobs: [{ digestHex, bytes: b64(bytes) }] }
    await index('shared-restore', 'restoreDocument', held, { documentId: one.documentId }, rng)
    await index('shared-purge', 'purgeTrashEntry', held, { documentId: one.documentId }, rng)
    await index('shared-purge-other', 'purgeTrashEntry', held, { documentId: two.documentId }, rng)
    await index('shared-list', 'listTrash', held, {}, rng)
  }
}

// ---- run ----

engine = await loadCrdtEngine()
const scenes: Scene[] = []
for (let i = 0; i < 8; i++) scenes.push(buildScene(10 + i, i % 2 === 1))
const pureScenes: Scene[] = [...scenes]
for (let i = 0; i < 4; i++) pureScenes.push(buildScene(200 + i, i % 2 === 1))

await recordFirstFreeSegment()
await recordNameRules(pureScenes)
await recordEntryRules(pureScenes)
await recordRestorable(scenes.slice(0, 5))
await recordIndexOps(scenes)

const body = `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`
writeFileSync(OUT, body)
console.log(`wrote ${rows.length} rows, ${body.length} bytes to ${OUT}`)
