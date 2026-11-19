/**
 * Records `src/oracle/crdt-write.jsonl`: for every writer of the loro cohort, the
 * bytes of a document BEFORE a write, the write as a name and JSON arguments,
 * and what loro-crdt and this package's writers leave behind — the deep value
 * with container ids, the version vector, the frontiers and the update bytes
 * the write produced — or the class of the refusal.
 *
 *   pnpm --filter @kamiazya/whiteboard-mcp exec tsx \
 *     ../loro-adapter/scripts/record-crdt-write-oracle.ts
 *
 * Peer ids are fixed, the clock is pinned and every random choice comes from a
 * seeded generator, so a re-run under the same loro-crdt writes the same file.
 * Each write is applied to a fresh import of the recorded before bytes, which
 * is exactly what the replay does, so nothing but the bytes and the arguments
 * carries state between the recorder and a port.
 *
 * Masked, because it is random: the peer of a replica a reader makes on the way
 * (`counter@*`, in a returned `Uint8Array`'s state). Every other id is
 * deterministic under a fixed writer peer.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  coreFacetsSchema,
  proposalSchema,
  type SpatialCanvas,
  trustFacetsSchema,
} from '@kamiazya/whiteboard-model'
import {
  arbitraryForSchema,
  commentThreadArbitrary,
  extensionFacetsArbitrary,
  spatialCanvasArbitrary,
  textNode,
} from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { readSpatialCanvas } from '../src/loro-bridge.js'
import { writeMarkdownBody } from '../src/markdown-body.js'
import { answer, frontierPairs, versionPairs } from '../src/test-utils/crdt-read-oracle.js'
import { applyWriter, type WriterName } from '../src/test-utils/crdt-write-oracle.js'
import {
  deleteWorkspaceDocument,
  documentContainers,
  setWorkspaceDocumentName,
  setWorkspacePinned,
} from '../src/workspace-tree.js'
import {
  body,
  int,
  peer,
  pick,
  type Rng,
  rngOf,
  sample,
  sentence,
  WIDE,
  WORDS,
} from './oracle-recorder-kit.js'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', 'src', 'oracle', 'crdt-write.jsonl')

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const fromB64 = (text: string) => {
  const doc = new LoroDoc()
  doc.import(new Uint8Array(Buffer.from(text, 'base64')))
  return doc
}

import {
  type ContentKind,
  documentScene,
  fillContent,
  KINDS,
  nextId,
  type Scene,
  seedTree,
  seedTreeIds,
  workspaceScene,
} from './oracle-write-scenes.js'

// ---- rows ----

interface Case {
  op: WriterName
  tag: string
  scene: Scene
  args: unknown
  /** The writer's replica; the before bytes were made by peer 1. */
  peer?: number
}

const cases: Case[] = []
const add = (op: WriterName, tag: string, scene: Scene, args: unknown, writerPeer = 1) =>
  cases.push({ op, tag, scene, args, peer: writerPeer })

/** A content writer's arguments carry the tree node's id when the scene hosts one. */
const hostArgs = (scene: Scene) =>
  scene.documentId === undefined ? {} : { documentId: scene.documentId }

function contentCases(
  op: WriterName,
  contents: readonly ContentKind[],
  argsOf: (scene: Scene, rng: Rng, i: number) => unknown[],
  seed: number,
) {
  contents.forEach((content, c) => {
    ;(['document', 'workspace'] as const).forEach((host, h) => {
      const rng = rngOf(seed + c * 10 + h)
      const scene = host === 'document' ? documentScene(content, rng) : workspaceScene(content, rng)
      argsOf(scene, rng, c).forEach((args, i) => {
        add(
          op,
          `${host}-${content}-${i}`,
          scene,
          { ...hostArgs(scene), ...(args as object) },
          1 + ((c + i) % 2),
        )
      })
    })
  })
}

const firstNodeId = (s: Scene) => s.facts.canvas?.nodes[0]?.id ?? 'missing'
const firstEdgeId = (s: Scene) => s.facts.canvas?.edges[0]?.id ?? 'missing'
const freshCanvas = (rng: Rng): SpatialCanvas =>
  sample(spatialCanvasArbitrary, rng, 1)[0] ?? { nodes: [], edges: [] }
const currentCanvas = (s: Scene): SpatialCanvas =>
  s.facts.canvas === undefined
    ? { nodes: [], edges: [] }
    : readSpatialCanvas(
        s.documentId === undefined ? s.doc : documentContainers(s.doc, s.documentId),
      )
const reserved = JSON.parse('{"visual.style/v1":{"__proto__":{"x":1}}}') as Record<string, unknown>

const SPATIAL: ContentKind[] = ['empty', 'spatial']
const TEXT: ContentKind[] = ['empty', 'markdown']

contentCases(
  'writeSpatialCanvas',
  SPATIAL,
  (s, rng) => [
    { canvas: freshCanvas(rng) },
    {
      canvas: {
        ...(s.facts.canvas ?? { nodes: [], edges: [] }),
        nodes: s.facts.canvas?.nodes.slice(1) ?? [],
      },
    },
    {
      canvas: {
        nodes: [
          {
            ...textNode({ id: 'r', x: 0, y: 0, width: 5, height: 5, text: 'r' }),
            facets: reserved,
          },
        ],
        edges: [],
      },
    },
  ],
  100,
)
contentCases(
  'writeSpatialNode',
  SPATIAL,
  (s, rng) => [
    { node: textNode({ id: 'new', x: 3, y: 4, width: 50, height: 20, text: pick(rng, WIDE) }) },
    {
      node: {
        ...textNode({ id: firstNodeId(s), x: 9, y: 9, width: 70, height: 30, text: 'moved' }),
      },
    },
  ],
  200,
)
contentCases(
  'writeSpatialEdge',
  SPATIAL,
  (s) => {
    const [a, b] = s.facts.canvas?.nodes ?? []
    const ends = { from: { node: a?.id ?? 'x' }, to: { node: b?.id ?? 'y' } }
    return [
      { edge: { id: 'e-new', ...ends } },
      { edge: { id: firstEdgeId(s), ...ends, label: 'again' } },
    ]
  },
  300,
)
contentCases('deleteSpatialNode', SPATIAL, (s) => [{ id: firstNodeId(s) }, { id: 'absent' }], 400)
contentCases('deleteSpatialEdge', SPATIAL, (s) => [{ id: firstEdgeId(s) }, { id: 'absent' }], 500)
contentCases(
  'reconcileSpatialCanvas',
  SPATIAL,
  (s, rng) => {
    const prev = currentCanvas(s)
    return [
      { prev, next: freshCanvas(rng) },
      { prev, next: { ...prev, nodes: prev.nodes.slice(1) } },
      {
        prev,
        next: { ...prev, nodes: prev.nodes.map((n, i) => (i === 0 ? { ...n, x: n.x + 7 } : n)) },
      },
      { prev, next: prev },
    ]
  },
  600,
)
contentCases(
  'setNodeLock',
  SPATIAL,
  (s) => [
    { id: firstNodeId(s), locked: true },
    { id: firstNodeId(s), locked: false },
  ],
  700,
)
contentCases(
  'setEdgeLock',
  SPATIAL,
  (s) => [
    { id: firstEdgeId(s), locked: true },
    { id: 'absent', locked: true },
  ],
  800,
)
contentCases(
  'withSpatialBatch',
  SPATIAL,
  (s, rng) => [
    {
      steps: [
        {
          op: 'writeNode',
          node: textNode({ id: 'b1', x: 0, y: 0, width: 5, height: 5, text: 'b' }),
        },
        { op: 'deleteNode', id: firstNodeId(s) },
        { op: 'writeEdge', edge: { id: 'be', from: { node: 'b1' }, to: { node: firstNodeId(s) } } },
        { op: 'deleteEdge', id: firstEdgeId(s) },
      ],
    },
    {
      steps: [
        {
          op: 'writeNode',
          node: textNode({ id: 'w', x: 1, y: 1, width: 5, height: 5, text: pick(rng, WIDE) }),
        },
      ],
    },
  ],
  900,
)

contentCases(
  'writeMarkdownBody',
  TEXT,
  (s, rng) => {
    const held = s.facts.text ?? ''
    return [
      { body: body(rng, true) },
      { body: held.replace('#', '# 😀') },
      { body: held.slice(0, Math.floor(held.length / 2)) },
      { body: `${held}\n\n${pick(rng, WIDE)}${pick(rng, WIDE)}` },
      { body: held },
    ]
  },
  1000,
)
contentCases(
  'writeDocumentKind',
  ['empty', 'markdown', 'spatial'],
  () => [{ kind: 'markdown' }, { kind: 'spatial' }],
  1100,
)
contentCases(
  'writeFacets',
  ['empty', 'markdown'],
  (_s, rng) => [
    { facets: sample(extensionFacetsArbitrary, rng, 1)[0] ?? {} },
    { facets: { 'visual.style/v1': { shape: pick(rng, WIDE) } } },
    { facets: reserved },
    { facets: {} },
  ],
  1200,
)
contentCases(
  'writeCoreFacets',
  ['empty', 'envelope'],
  (_s, rng) => {
    const [core] = sample(arbitraryForSchema(coreFacetsSchema), rng, 2)
    const { title: _title, ...stored } = core ?? {}
    return [{ core: stored }, { core: {} }]
  },
  1300,
)
contentCases(
  'writeTrustFacets',
  ['empty', 'envelope'],
  (_s, rng) => [{ trust: sample(arbitraryForSchema(trustFacetsSchema), rng, 1)[0] ?? {} }],
  1400,
)
contentCases(
  'reconcileFacets',
  ['empty', 'markdown'],
  (_s, rng) => {
    const a = sample(extensionFacetsArbitrary, rng, 1)[0] ?? {}
    return [
      { prev: {}, next: a },
      { prev: a, next: { 'visual.style/v1': { shape: 'x' } } },
      { prev: a, next: {} },
    ]
  },
  1500,
)
contentCases(
  'reconcileCoreFacets',
  ['empty', 'envelope'],
  (_s, rng) => {
    const [core] = sample(arbitraryForSchema(coreFacetsSchema), rng, 1)
    const { title: _title, ...stored } = core ?? {}
    return [{ next: stored }, { prev: stored, next: {} }]
  },
  1600,
)
contentCases(
  'writeCanvasFacetsField',
  SPATIAL,
  (_s, rng) => [
    { next: sample(extensionFacetsArbitrary, rng, 1)[0] ?? {} },
    { next: {} },
    { next: undefined },
    { next: reserved },
  ],
  1700,
)

contentCases(
  'writeCommentThread',
  ['empty', 'markdown', 'threads'],
  (s, rng) => {
    const thread = sample(commentThreadArbitrary, rng, 1)[0]
    const id = s.facts.threadIds[0] ?? 'fresh'
    return [
      { thread: { ...thread, id: 'fresh' } },
      { thread: { ...thread, id } },
      {
        thread: {
          id: 'same',
          anchor: { kind: 'spatial', x: 1, y: 2 },
          status: 'open',
          messages: [{ id: 'ma', body: 'A' }],
        },
      },
    ]
  },
  1800,
)
contentCases(
  'writeThreadMessage',
  ['empty', 'threads'],
  (s, rng) => [
    { threadId: s.facts.threadIds[0] ?? 'absent', message: { id: 'late', body: sentence(rng, 4) } },
    { threadId: 'absent', message: { id: 'late', body: 'x' } },
  ],
  1900,
)
contentCases(
  'setCommentThreadStatus',
  ['empty', 'threads'],
  (s) => [
    { threadId: s.facts.threadIds[0] ?? 'absent', status: 'resolved' },
    { threadId: s.facts.threadIds[1] ?? 'absent', status: 'open' },
  ],
  2000,
)
contentCases(
  'moveCommentThread',
  ['empty', 'threads'],
  (s) => [
    { threadId: s.facts.threadIds[0] ?? 'absent', drop: { x: 5, y: 6 } },
    { threadId: s.facts.threadIds[1] ?? 'absent', drop: { x: 1, y: 2, nodeId: 'n1' } },
  ],
  2100,
)
contentCases(
  'markThreadPassages',
  ['threads'],
  (s, rng) => {
    const length = (s.facts.text ?? '').length
    const ranges = s.facts.threadIds.map((id): [string, { start: number; end: number }] => {
      const start = int(rng, 0, Math.max(0, length - 2))
      return [id, { start, end: Math.min(length, start + int(rng, 1, 6)) }]
    })
    return [
      { passages: ranges },
      { passages: [] },
      { passages: [[s.facts.threadIds[0] ?? 't0', { start: 0, end: length + 9 }]] },
    ]
  },
  2200,
)
contentCases(
  'writeProposal',
  ['empty', 'markdown', 'proposals'],
  (s, rng) => {
    const [proposal] = sample(arbitraryForSchema(proposalSchema), rng, 1)
    return [
      { proposal: { ...proposal, id: 'fresh' } },
      { proposal: { ...proposal, id: s.facts.proposals[0]?.id ?? 'p0' } },
    ]
  },
  2300,
)
contentCases(
  'setProposedChangeStatus',
  ['empty', 'proposals'],
  (s) => {
    const proposal = s.facts.proposals[0]
    const change = proposal?.changes[0]
    return [
      { proposalId: proposal?.id ?? 'p0', changeId: change?.id ?? 'c0', status: 'adopted' },
      { proposalId: proposal?.id ?? 'p0', changeId: change?.id ?? 'c0', status: 'dismissed' },
      { proposalId: 'absent', changeId: 'c0', status: 'adopted' },
    ]
  },
  2400,
)
contentCases(
  'withDocumentBatch',
  ['empty', 'markdown'],
  (s, rng) => [
    {
      steps: [
        { op: 'writeMarkdownBody', body: body(rng, true) },
        { op: 'reconcileSpatialCanvas', prev: { nodes: [], edges: [] }, next: freshCanvas(rng) },
        { op: 'setProposedChangeStatus', proposalId: 'absent', changeId: 'c', status: 'adopted' },
      ],
    },
    { steps: [{ op: 'writeMarkdownBody', body: s.facts.text ?? '' }] },
    { steps: [] },
  ],
  2500,
)

// ---- whole-content writes between LoroDocs ----

function sourceDoc(content: ContentKind, rng: Rng): string {
  const source = peer(new LoroDoc(), 7)
  fillContent(source, content, rng)
  const text = body(rng, true)
  if (content === 'markdown') writeMarkdownBody(source, text)
  source.commit()
  return b64(source.export({ mode: 'snapshot' }))
}

;(['empty', 'markdown', 'spatial', 'threads'] as const).forEach((content, c) => {
  const rng = rngOf(3000 + c)
  const scene = documentScene(content, rng)
  add('reconcileDocContent', `document-${content}-other`, scene, {
    past: sourceDoc(pick(rng, ['markdown', 'spatial', 'threads']), rng),
  })
  add('reconcileDocContent', `document-${content}-same`, scene, {
    past: b64(scene.doc.export({ mode: 'snapshot' })),
  })
  add('reconcileDocContent', `document-${content}-empty`, scene, { past: sourceDoc('empty', rng) })
})
;(['empty', 'markdown', 'spatial', 'threads'] as const).forEach((content, c) => {
  const rng = rngOf(3100 + c)
  const scene = workspaceScene(content, rng)
  const id = scene.documentId ?? 'absent'
  for (const [i, source] of [
    sourceDoc('markdown', rng),
    sourceDoc('spatial', rng),
    sourceDoc('threads', rng),
    sourceDoc('empty', rng),
  ].entries()) {
    add('writeWorkspaceDocumentContent', `ws-${content}-${i}`, scene, {
      documentId: id,
      source,
      ...(i === 0 ? { updatedAt: 424242 } : {}),
    })
    if (i < 2)
      add('writeDocumentContentAndName', `ws-${content}-${i}`, scene, { documentId: id, source })
  }
  add('writeWorkspaceDocumentContent', `ws-${content}-absent`, scene, {
    documentId: 'absent',
    source: sourceDoc('markdown', rng),
  })
  add('writeDocumentContentAndName', `ws-${content}-absent`, scene, {
    documentId: 'absent',
    source: sourceDoc('markdown', rng),
  })
  add('seedNameFromTitle', `ws-${content}`, scene, { documentId: id })
  add('seedNameFromTitle', `ws-${content}-absent`, scene, { documentId: 'absent' })
})

// ---- the workspace tree ----

for (let i = 0; i < 4; i++) {
  const rng = rngOf(4000 + i)
  const scene = workspaceScene('empty', rng)
  const ids = scene.doc
    .getTree('tree')
    .getNodes()
    .map((n) => n.id)
  const known = seedTreeIds(scene)
  const [a, b] = known
  const free = `fresh/${pick(rng, WORDS)}${i}`
  add('createWorkspaceDocumentAtPath', `fresh-${i}`, scene, {
    path: free,
    documentId: nextId(),
    kind: pick(rng, KINDS),
    createdAt: 5000 + i,
    updatedAt: 5000 + i,
  })
  add('createWorkspaceDocumentAtPath', `named-${i}`, scene, {
    path: `${free}/deeper`,
    documentId: nextId(),
    kind: 'markdown',
    name: sentence(rng, 2),
  })
  add('createWorkspaceDocumentAtPath', `taken-${i}`, scene, {
    path: a?.path ?? 'none',
    documentId: nextId(),
    kind: 'markdown',
  })
  add('createWorkspaceDocumentAtPath', `under-document-${i}`, scene, {
    path: `${a?.path ?? 'none'}/child`,
    documentId: nextId(),
    kind: 'markdown',
    createdAt: 1,
    updatedAt: 2,
  })
  add('createWorkspaceDocumentAtPath', `invalid-${i}`, scene, {
    path: 'x/y',
    documentId: 'not-a-ulid',
    kind: 'markdown',
  })
  add('createWorkspaceDocument', `root-${i}`, scene, {
    documentId: nextId(),
    segment: `root${i}`,
    kind: 'spatial',
    createdAt: 9,
    updatedAt: 9,
  })
  add('createWorkspaceDocument', `child-${i}`, scene, {
    documentId: nextId(),
    segment: 'child',
    kind: 'markdown',
    parentId: a?.id,
  })
  add('createWorkspaceDocument', `orphan-${i}`, scene, {
    documentId: nextId(),
    segment: 'child',
    kind: 'markdown',
    parentId: 'absent',
  })
  add('ensureFolderPath', `new-${i}`, scene, { segments: ['p', 'q', `r${i}`] })
  add('ensureFolderPath', `existing-${i}`, scene, {
    segments: (a?.path ?? 'notes/x').split('/').slice(0, -1),
  })
  add('ensureFolderPath', `empty-${i}`, scene, { segments: [] })
  add('moveWorkspaceDocument', `reparent-${i}`, scene, {
    documentId: b?.id ?? 'absent',
    parentId: a?.id,
  })
  add('moveWorkspaceDocument', `to-root-${i}`, scene, { documentId: b?.id ?? 'absent' })
  add('moveWorkspaceDocument', `absent-${i}`, scene, { documentId: 'absent' })
  add('moveWorkspaceDocument', `cycle-${i}`, scene, {
    documentId: a?.id ?? 'absent',
    parentId: a?.id,
  })
  add('moveWorkspaceNodeToPath', `folder-${i}`, scene, { from: 'notes', to: `archive/notes${i}` })
  add('moveWorkspaceNodeToPath', `document-${i}`, scene, {
    from: a?.path ?? 'none',
    to: 'moved/deep/leaf',
  })
  add('moveWorkspaceNodeToPath', `absent-${i}`, scene, { from: 'nope', to: 'x' })
  add('setWorkspaceDocumentName', `name-${i}`, scene, {
    documentId: a?.id ?? 'absent',
    name: `${sentence(rng, 2)} ${pick(rng, WIDE)}`,
  })
  add('setWorkspaceDocumentName', `blank-${i}`, scene, {
    documentId: a?.id ?? 'absent',
    name: '   ',
  })
  add('setWorkspaceDocumentName', `clear-${i}`, scene, { documentId: b?.id ?? 'absent' })
  add('setWorkspaceDocumentName', `absent-${i}`, scene, { documentId: 'absent', name: 'x' })
  add('setWorkspaceFolderName', `set-${i}`, scene, {
    path: 'notes',
    name: `${sentence(rng, 2)} ${pick(rng, WIDE)}`,
  })
  add('setWorkspaceFolderName', `clear-${i}`, scene, { path: 'notes' })
  add('setWorkspaceFolderName', `refused-${i}`, scene, { path: 'notes', name: '' })
  add('setWorkspaceFolderName', `absent-${i}`, scene, { path: 'nope', name: 'x' })
  add('deleteWorkspaceDocument', `leaf-${i}`, scene, { documentId: b?.id ?? 'absent' })
  add('deleteWorkspaceDocument', `absent-${i}`, scene, { documentId: 'absent' })
  add('deleteWorkspaceNode', `node-${i}`, scene, { id: ids[i % Math.max(1, ids.length)] ?? '0@1' })
  add('deleteWorkspaceNode', `absent-${i}`, scene, { id: '999@1' })
  add('deleteWorkspaceNodeAtPath', `folder-${i}`, scene, { path: 'notes' })
  add('deleteWorkspaceNodeAtPath', `absent-${i}`, scene, { path: 'nope' })
  add('setWorkspaceLastCompactedAt', `at-${i}`, scene, { at: 1000 * (i + 1) })
  add('setWorkspaceLastCompactedAt', `negative-${i}`, scene, { at: -1 })
  add('setWorkspacePinned', `pin-${i}`, scene, { documentId: a?.id ?? 'absent', pinned: true })
  add('setWorkspacePinned', `unpin-${i}`, scene, { documentId: a?.id ?? 'absent', pinned: false })
  add('setWorkspacePinned', `invalid-${i}`, scene, { documentId: 'not-a-ulid', pinned: true })
  add('recordTrashEntry', `entry-${i}`, scene, {
    entry: {
      documentId: a?.id ?? 'absent',
      path: `gone/${i}`,
      ...(i % 2 === 0 ? { name: sentence(rng, 2) } : {}),
      ...(i === 0 ? { folderNames: [{ path: 'gone', name: 'Gone' }] } : {}),
      deletedAt: 5000 + i,
      blob: { algorithm: 'sha-256', digestHex: 'ab'.repeat(32) },
    },
  })
  add('updateWorkspaceDocumentMeta', `patch-${i}`, scene, {
    documentId: a?.id ?? 'absent',
    patch: { updatedAt: 9000 + i, ...(i % 2 === 0 ? { kind: 'spatial' } : {}) },
  })
  add('updateWorkspaceDocumentMeta', `absent-${i}`, scene, {
    documentId: 'absent',
    patch: { updatedAt: 1 },
  })
  add('updateWorkspaceDocumentMeta', `refused-${i}`, scene, {
    documentId: a?.id ?? 'absent',
    patch: { documentId: 'x' },
  })
  add('pruneEmptyFolders', `populated-${i}`, scene, {})
  add('recordTrashEntry', `invalid-${i}`, scene, {
    entry: { documentId: a?.id ?? 'absent', path: '' },
  })
}

for (let i = 0; i < 4; i++) {
  const rng = rngOf(5500 + i)
  const scene = workspaceScene('empty', rng)
  for (const { id } of seedTreeIds(scene)) deleteWorkspaceDocument(scene.doc, { documentId: id })
  add('pruneEmptyFolders', `emptied-${i}`, scene, {})
}

// ---- duplicate, touched, stamp ----

for (const [i, content] of (
  ['empty', 'markdown', 'spatial', 'threads', 'proposals'] as const
).entries()) {
  const rng = rngOf(5000 + i)
  const scene = workspaceScene(content, rng)
  const id = scene.documentId ?? 'absent'
  add('duplicateWorkspaceDocument', `copy-${content}`, scene, {
    sourceDocumentId: id,
    documentId: nextId(),
    path: `copies/${content}`,
    name: 'Copy',
  })
  add('duplicateWorkspaceDocument', `bare-${content}`, scene, {
    sourceDocumentId: id,
    documentId: nextId(),
    path: `copies/bare-${content}`,
    name: 'Bare',
    withoutAnnotations: true,
  })
  add('duplicateWorkspaceDocument', `absent-${content}`, scene, {
    sourceDocumentId: 'absent',
    documentId: nextId(),
    path: 'copies/x',
    name: 'x',
  })
  add('duplicateWorkspaceDocument', `taken-${content}`, scene, {
    sourceDocumentId: id,
    documentId: nextId(),
    path: seedTreeIds(scene)[0]?.path ?? 'none',
    name: 'Taken',
  })
}
for (let i = 0; i < 4; i++) {
  const rng = rngOf(6000 + i)
  const doc = peer(new LoroDoc(), 1)
  const ids = seedTree(doc, rng, 3)
  const since = versionPairs(doc.oplogVersion())
  const [first, second] = ids
  if (first !== undefined) {
    writeMarkdownBody(
      documentContainers(doc, first.id),
      `# ${sentence(rng, 3)}\n\n${body(rng, true)}`,
    )
    setWorkspacePinned(doc, first.id, true)
  }
  if (second !== undefined)
    setWorkspaceDocumentName(doc, { documentId: second.id, name: 'Renamed' })
  if (i % 2 === 0 && ids[2] !== undefined) deleteWorkspaceDocument(doc, { documentId: ids[2].id })
  const scene: Scene = { doc, host: 'workspace', facts: { threadIds: [], proposals: [] } }
  add('seedNamesFromTitles', `touched-${i}`, scene, { since })
  add('seedNamesFromTitles', `nothing-${i}`, scene, { since: versionPairs(doc.oplogVersion()) })
  add('stampEditedDocuments', `touched-${i}`, scene, { since, at: 777000 + i })
  add('stampEditedDocuments', `nothing-${i}`, scene, {
    since: versionPairs(doc.oplogVersion()),
    at: 1,
  })
}

// ---- pure ----

const PAIRS: Array<[string, string]> = [
  ['', ''],
  ['', 'hello'],
  ['hello', ''],
  ['hello world', 'hello brave world'],
  ['abcabc', 'abc'],
  ['aaa', 'aaaa'],
  ['😀 end', '😁 end'],
  ['a😀b', 'a😁b'],
  ['x👩‍👩‍👧y', 'x👩‍👩‍👦y'],
  ['𝒳𝒳', '𝒳'],
  ['日本語', '日本'],
  ['é', 'é'],
  ['same', 'same'],
  ['\u{10FFFF}a', 'a'],
  ['ab😀', 'ab😀😀'],
]
const pureScene: Scene = {
  doc: peer(new LoroDoc(), 1),
  host: 'document',
  facts: { threadIds: [], proposals: [] },
}
for (const [i, [current, next]] of PAIRS.entries()) {
  add('minimalChange', `pair-${i}`, pureScene, { current, next })
}

// ---- recording ----

function record(c: Case, index: number): string {
  const { scene } = c
  scene.doc.commit()
  const before = b64(scene.doc.export({ mode: 'snapshot' }))
  const writerPeer = c.peer ?? 1
  const doc = fromB64(before)
  doc.setPeerId(BigInt(writerPeer))
  const beforeVersion = doc.oplogVersion()
  const args: unknown = JSON.parse(JSON.stringify(c.args) ?? 'null')
  const result = answer(() => applyWriter(doc, c.op, args))
  doc.commit()
  const after = fromB64(b64(doc.export({ mode: 'update' })))
  return JSON.stringify({
    id: `${c.op}-${c.tag}-${index}`,
    op: c.op,
    tag: c.tag,
    host: scene.host,
    peer: writerPeer,
    before,
    args,
    result,
    deep: after.toJSON(),
    ids: after.getDeepValueWithID(),
    vv: versionPairs(doc.oplogVersion()),
    frontiers: frontierPairs(doc.frontiers()),
    update: b64(doc.export({ mode: 'update', from: beforeVersion })),
  })
}

const lines = cases.map(record)
writeFileSync(OUT, `${lines.join('\n')}\n`)
console.log(`wrote ${lines.length} rows to ${OUT}`)
