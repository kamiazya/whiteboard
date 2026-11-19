/**
 * Records `src/oracle/crdt-read.jsonl`: for every stored shape the loro cohort
 * writes, the bytes this package's own writers produce under the installed
 * loro-crdt, and what loro-crdt and this package's readers answer for them.
 *
 *   pnpm --filter @kamiazya/whiteboard-mcp exec tsx \
 *     ../loro-adapter/scripts/record-crdt-read-oracle.ts
 *
 * Peer ids are fixed, the clock is pinned and every random choice comes from a
 * seeded generator, so a re-run under the same loro-crdt writes the same file.
 * The recording is the oracle for the Rust `whiteboard-crdt` crate: re-take it
 * only deliberately, with the version it should pin installed.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type CanvasLine,
  coreFacetsSchema,
  type Proposal,
  proposalSchema,
  trustFacetsSchema,
} from '@kamiazya/whiteboard-model'
import {
  arbitraryForSchema,
  canvasLineArbitrary,
  commentThreadArbitrary,
  extensionFacetsArbitrary,
  fc,
  groupNode,
  spatialCanvasArbitrary,
  textNode,
} from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import {
  setCommentThreadStatus,
  writeCommentThread,
  writeThreadMessage,
} from '../src/comment-threads.js'
import type { DocumentContainers } from '../src/containers.js'
import {
  writeCoreFacets,
  writeDocumentKind,
  writeFacets,
  writeTrustFacets,
} from '../src/document-envelope.js'
import {
  deleteSpatialNode,
  setEdgeLock,
  setNodeLock,
  writeSpatialCanvas,
} from '../src/loro-bridge.js'
import { writeMarkdownBody } from '../src/markdown-body.js'
import { setProposedChangeStatus, writeProposal } from '../src/proposals.js'
import {
  frontierPairs,
  rootDocumentReaders,
  versionPairs,
  workspaceReaders,
} from '../src/test-utils/crdt-read-oracle.js'
import { markThreadPassages } from '../src/thread-marks.js'
import { setWorkspaceFolderName } from '../src/workspace-folder-name.js'
import { recordTrashEntry } from '../src/workspace-trash.js'
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceDocument,
  deleteWorkspaceNodeAtPath,
  documentContainers,
  moveWorkspaceNodeToPath,
  setWorkspaceDocumentName,
  setWorkspaceLastCompactedAt,
  setWorkspacePinned,
} from '../src/workspace-tree.js'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', 'src', 'oracle', 'crdt-read.jsonl')

const NOW = 1_700_000_000_000
Date.now = () => NOW

function rngOf(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ulid = (n: number): string =>
  `01ARZ3NDEKTSV4RRFFQ69G5F${CROCKFORD[(n >> 5) & 31]}${CROCKFORD[n & 31]}`.slice(0, 26)

const WORDS = ['plan', 'draft', 'report', 'Friday', 'review', 'ship', 'weekly', 'notes', 'idea']
const WIDE = ['😀', '👩‍👩‍👧', '𝒳', '日本語', 'é', 'é', '🇯🇵', '\u{10FFFF}', '\u0000']

type Rng = () => number
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T
const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1))
const sentence = (rng: Rng, n = int(rng, 3, 12)) =>
  Array.from({ length: n }, () => pick(rng, WORDS)).join(' ')
const body = (rng: Rng, wide = false) =>
  Array.from({ length: int(rng, 1, 4) }, (_, i) => {
    const text = sentence(rng)
    const spice = wide ? ` ${pick(rng, WIDE)}${pick(rng, WIDE)} ` : ''
    return i === 0 ? `# ${text}${spice}` : `${text}${spice}`
  }).join('\n\n')

/**
 * Schema-derived payloads run to tens of kilobytes; the smallest of a wider draw
 * keeps the recording a size a repository carries, and still varies by seed.
 */
function sample<T>(arb: fc.Arbitrary<T>, rng: Rng, n: number): T[] {
  const drawn = fc.sample(arb, { seed: Math.floor(rng() * 2 ** 31), numRuns: n * 5 })
  // An empty bucket is the smallest of all and would starve the shapes that need content.
  return drawn
    .map((value) => ({ value, size: JSON.stringify(value).length }))
    .map((entry) => (entry.size <= 2 ? { ...entry, size: 10 ** 9 } : entry))
    .sort((a, b) => a.size - b.size)
    .slice(0, n)
    .map(({ value }) => value)
}

/** A writer a generated payload may legitimately refuse: the row still records what landed. */
function attempt(write: () => void): void {
  try {
    write()
  } catch {
    // a refusal is a shape the writers do not store
  }
}

const peer = (doc: LoroDoc, id: number): LoroDoc => {
  doc.setPeerId(BigInt(id))
  return doc
}

interface Spec {
  id: string
  shape: string
  host: 'workspace' | 'document'
  doc: LoroDoc
  since?: LoroDoc
  /** A forked history point, so the since-version readers have a non-empty answer. */
  sinceVersion?: ReturnType<LoroDoc['oplogVersion']>
}

const specs: Spec[] = []
let serial = 0
function add(shape: string, host: Spec['host'], doc: LoroDoc, sinceVersion?: Spec['sinceVersion']) {
  specs.push({ id: `${shape}-${serial++}`, shape, host, doc, sinceVersion })
}

// ---- content writers over a host (a LoroDoc root or a tree node) ----

function spatialContent(host: DocumentContainers, rng: Rng, withLines: boolean) {
  const [canvas] = sample(spatialCanvasArbitrary, rng, 1)
  const lines: CanvasLine[] = withLines ? sample(canvasLineArbitrary, rng, int(rng, 1, 3)) : []
  const base = canvas ?? { nodes: [], edges: [] }
  const [first, second] = base.nodes
  const edges =
    first !== undefined && second !== undefined && base.edges.length === 0
      ? [{ id: 'e1', from: { node: first.id }, to: { node: second.id } }]
      : base.edges
  const framed = {
    ...base,
    edges,
    ...(lines.length > 0 ? { lines } : {}),
  }
  attempt(() => writeSpatialCanvas(host, framed))
  if (rng() < 0.5) {
    attempt(() =>
      writeSpatialCanvas(host, {
        ...framed,
        nodes: [
          ...framed.nodes,
          groupNode({ id: 'g1', x: 0, y: 0, width: 400, height: 300, label: sentence(rng, 2) }),
          textNode({ id: 't1', x: 10, y: 10, width: 120, height: 60, text: pick(rng, WIDE) }),
        ],
      }),
    )
  }
  return framed
}

function markdownContent(host: DocumentContainers, rng: Rng, wide: boolean) {
  attempt(() => writeDocumentKind(host, 'markdown'))
  const first = body(rng, wide)
  writeMarkdownBody(host, first)
  if (rng() < 0.6) writeMarkdownBody(host, `${first}\n\n${body(rng, wide)}`)
  return first
}

function threadsContent(
  host: DocumentContainers,
  doc: LoroDoc | undefined,
  rng: Rng,
  text: string,
) {
  const threads = sample(commentThreadArbitrary, rng, int(rng, 1, 3))
  const ranges = new Map<string, { start: number; end: number }>()
  threads.forEach((thread, i) => {
    attempt(() => writeCommentThread(host, { ...thread, id: `t${i}` }))
    const start = Math.min(text.length, int(rng, 0, Math.max(0, text.length - 1)))
    ranges.set(`t${i}`, { start, end: Math.min(text.length, start + int(rng, 1, 6)) })
  })
  attempt(() => writeThreadMessage(host, 't0', { id: 'late', body: sentence(rng, 3) }))
  if (rng() < 0.4) attempt(() => setCommentThreadStatus(host, 't0', 'resolved'))
  if (doc !== undefined && text.length > 0) attempt(() => markThreadPassages(doc, host, ranges))
}

function proposalsContent(host: DocumentContainers, rng: Rng) {
  const proposals = sample(arbitraryForSchema(proposalSchema), rng, int(rng, 1, 3))
  proposals.forEach((proposal: Proposal, i) => {
    attempt(() => writeProposal(host, { ...proposal, id: `p${i}` }))
  })
  const first = proposals[0]?.changes[0]
  if (first !== undefined && rng() < 0.5) {
    attempt(() => setProposedChangeStatus(host, 'p0', first.id, 'dismissed'))
  }
}

function envelopeContent(host: DocumentContainers, rng: Rng) {
  const [core] = sample(arbitraryForSchema(coreFacetsSchema), rng, 1)
  const [trust] = sample(arbitraryForSchema(trustFacetsSchema), rng, 1)
  const [facets] = sample(extensionFacetsArbitrary, rng, 1)
  if (core !== undefined) {
    const { title: _title, ...stored } = core
    attempt(() => writeCoreFacets(host, stored))
  }
  if (trust !== undefined) attempt(() => writeTrustFacets(host, trust))
  attempt(() => writeFacets(host, { ...facets, 'visual.style/v1': { shape: pick(rng, WIDE) } }))
}

/** Everything a content host may hold, chosen per row. */
function anyContent(host: DocumentContainers, doc: LoroDoc | undefined, rng: Rng) {
  if (rng() < 0.5) {
    spatialContent(host, rng, rng() < 0.5)
    attempt(() => writeDocumentKind(host, 'spatial'))
  } else {
    const text = markdownContent(host, rng, rng() < 0.4)
    if (rng() < 0.5) threadsContent(host, doc, rng, text)
    if (rng() < 0.4) envelopeContent(host, rng)
  }
  if (rng() < 0.3) proposalsContent(host, rng)
}

// ---- documents ----

add('doc-empty', 'document', peer(new LoroDoc(), 1))

for (let i = 0; i < 26; i++) {
  const rng = rngOf(1000 + i)
  const doc = peer(new LoroDoc(), 1)
  spatialContent(doc, rng, i % 2 === 0)
  add('doc-spatial', 'document', doc)
}
for (let i = 0; i < 7; i++) {
  const rng = rngOf(1100 + i)
  const doc = peer(new LoroDoc(), 1)
  const canvas = spatialContent(doc, rng, true)
  for (const node of canvas.nodes.slice(0, 2)) attempt(() => setNodeLock(doc, node.id, true))
  for (const edge of canvas.edges.slice(0, 1)) attempt(() => setEdgeLock(doc, edge.id, true))
  for (const line of canvas.lines?.slice(0, 1) ?? []) attempt(() => setEdgeLock(doc, line.id, true))
  add('doc-spatial-locked', 'document', doc)
}
for (let i = 0; i < 40; i++) {
  const rng = rngOf(1200 + i)
  const doc = peer(new LoroDoc(), 1)
  markdownContent(doc, rng, false)
  add('doc-markdown', 'document', doc)
}
for (let i = 0; i < 14; i++) {
  const rng = rngOf(1300 + i)
  const doc = peer(new LoroDoc(), 1)
  const text = markdownContent(doc, rng, true)
  // an edit in the middle of a pair's neighbourhood, so a splice offset is UTF-16 not scalar
  writeMarkdownBody(doc, text.replace('#', '# 😀'))
  if (i % 3 === 0) threadsContent(doc, doc, rng, text)
  add('doc-markdown-utf16', 'document', doc)
}
for (let i = 0; i < 12; i++) {
  const rng = rngOf(1400 + i)
  const doc = peer(new LoroDoc(), 1)
  markdownContent(doc, rng, false)
  envelopeContent(doc, rng)
  add('doc-envelope', 'document', doc)
}
for (let i = 0; i < 18; i++) {
  const rng = rngOf(1500 + i)
  const doc = peer(new LoroDoc(), 1)
  if (i % 3 === 2) {
    spatialContent(doc, rng, false)
    attempt(() => writeDocumentKind(doc, 'spatial'))
    threadsContent(doc, doc, rng, '')
  } else {
    threadsContent(doc, doc, rng, markdownContent(doc, rng, i % 2 === 0))
  }
  add('doc-threads', 'document', doc)
}
for (let i = 0; i < 12; i++) {
  const rng = rngOf(1600 + i)
  const doc = peer(new LoroDoc(), 1)
  if (i % 2 === 0) spatialContent(doc, rng, false)
  else markdownContent(doc, rng, false)
  proposalsContent(doc, rng)
  add('doc-proposals', 'document', doc)
}
for (let i = 0; i < 18; i++) {
  const rng = rngOf(1700 + i)
  const a = peer(new LoroDoc(), 11)
  const text = markdownContent(a, rng, i % 2 === 0)
  spatialContent(a, rng, false)
  threadsContent(a, a, rng, text)
  const base = a.oplogVersion()
  const b = peer(new LoroDoc(), 12)
  b.import(a.export({ mode: 'snapshot' }))
  // the same thread id created on both sides, the case a mergeable container exists for
  writeCommentThread(a, {
    id: 'same',
    anchor: { kind: 'spatial', x: 1, y: 2 },
    status: 'open',
    messages: [{ id: 'ma', body: 'A' }],
  })
  writeCommentThread(b, {
    id: 'same',
    anchor: { kind: 'spatial', x: 3, y: 4 },
    status: 'open',
    messages: [{ id: 'mb', body: 'B' }],
  })
  writeMarkdownBody(a, `${text}\n\nfrom a ${pick(rng, WIDE)}`)
  writeMarkdownBody(b, `from b\n\n${text}`)
  attempt(() =>
    writeSpatialCanvas(b, {
      nodes: [textNode({ id: 'b1', x: 0, y: 0, width: 10, height: 10, text: 'b' })],
      edges: [],
    }),
  )
  a.import(b.export({ mode: 'update', from: a.oplogVersion() }))
  b.import(a.export({ mode: 'update', from: b.oplogVersion() }))
  void base
  add('doc-concurrent', 'document', a)
}
for (let i = 0; i < 14; i++) {
  const rng = rngOf(1800 + i)
  const doc = peer(new LoroDoc(), 1)
  const canvas = spatialContent(doc, rng, true)
  const text = markdownContent(doc, rng, true)
  threadsContent(doc, doc, rng, text)
  proposalsContent(doc, rng)
  for (const node of canvas.nodes.slice(0, 2)) attempt(() => deleteSpatialNode(doc, node.id))
  for (const edge of canvas.edges.slice(0, 1)) doc.getMap('edges').delete(edge.id)
  writeMarkdownBody(doc, text.slice(0, Math.floor(text.length / 2)))
  doc.getMap('threads').delete('t0')
  doc.commit()
  add('doc-deleted', 'document', doc)
}
{
  const retired: Array<(doc: LoroDoc) => void> = [
    (d) =>
      d
        .getMap('nodes')
        .set('n1', { id: 'n1', type: 'text', text: 'old', x: 0, y: 0, width: 1, height: 1 }),
    (d) => d.getMap('nodes').set('n1', { id: 'n1', 'x-whiteboard': { a: 1 } }),
    (d) => d.getMap('edges').set('e1', { id: 'e1', 'x-whiteboard': {} }),
    (d) => d.getMap('canvas').set('x-whiteboard', { a: 1 }),
    (d) => d.getMap('comments').set('c1', { id: 'c1', body: 'old' }),
    (d) => d.getMovableList('elements').push('x'),
    (d) => {
      d.getMap('document').set('kind', 'markdown')
      d.getMap('nodes').set('okf-body', {
        id: 'okf-body',
        resource: { mimeType: 'text/markdown', content: '# old' },
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      })
    },
    (d) => d.getMovableList('elements').insert(0, 'x'),
  ]
  retired.forEach((write, i) => {
    const doc = peer(new LoroDoc(), 1)
    write(doc)
    doc.commit()
    add('doc-retired', 'document', doc)
    void i
  })
}

// ---- workspaces ----

const KINDS = ['markdown', 'spatial'] as const
let docCounter = 0
const nextId = () => ulid(++docCounter % 1000)

function seedTree(doc: LoroDoc, rng: Rng, count: number, hosted: boolean): string[] {
  const made: string[] = []
  const folders = ['notes', 'boards', 'archive', 'a/b', 'x/y/z']
  for (let k = 0; k < count; k++) {
    const path = `${rng() < 0.6 ? `${pick(rng, folders)}/` : ''}${pick(rng, WORDS)}${k}`
    const documentId = nextId()
    const kind = pick(rng, KINDS)
    const created = createWorkspaceDocumentAtPath(doc, {
      path,
      documentId,
      kind,
      createdAt: 1000 + k,
      updatedAt: 1000 + k,
      ...(rng() < 0.4 ? { name: `${pick(rng, WORDS)} ${k}` } : {}),
    })
    if (created === null) continue
    made.push(documentId)
    if (hosted) anyContent(documentContainers(doc, documentId), doc, rng)
  }
  return made
}

add('ws-empty', 'workspace', peer(new LoroDoc(), 1))
for (let i = 0; i < 30; i++) {
  const rng = rngOf(2000 + i)
  const doc = peer(new LoroDoc(), 1)
  seedTree(doc, rng, int(rng, 1, 8), false)
  add('ws-tree', 'workspace', doc)
}
for (let i = 0; i < 4; i++) {
  const doc = peer(new LoroDoc(), 1)
  const depth = [12, 24, 40, 60][i] as number
  const path = Array.from({ length: depth }, (_, d) => `d${d}`).join('/')
  createWorkspaceDocumentAtPath(doc, {
    path,
    documentId: nextId(),
    kind: 'markdown',
    createdAt: 1,
    updatedAt: 1,
  })
  add('ws-deep', 'workspace', doc)
}
for (let i = 0; i < 12; i++) {
  const rng = rngOf(2100 + i)
  const doc = peer(new LoroDoc(), 1)
  const ids = seedTree(doc, rng, int(rng, 3, 8), i % 2 === 0)
  const since = doc.oplogVersion()
  for (const id of ids.slice(0, 2)) deleteWorkspaceDocument(doc, { documentId: id })
  deleteWorkspaceNodeAtPath(doc, 'notes')
  add('ws-deleted', 'workspace', doc, since)
}
for (let i = 0; i < 6; i++) {
  const rng = rngOf(2200 + i)
  const doc = peer(new LoroDoc(), 1)
  createWorkspaceDocumentAtPath(doc, {
    path: 'a/b/leaf',
    documentId: nextId(),
    kind: 'markdown',
    createdAt: 1,
    updatedAt: 1,
  })
  createWorkspaceDocumentAtPath(doc, {
    path: 'x/note',
    documentId: nextId(),
    kind: 'spatial',
    createdAt: 1,
    updatedAt: 1,
  })
  attempt(() =>
    setWorkspaceFolderName(doc, { path: 'a', name: `${pick(rng, WORDS)} ${pick(rng, WIDE)}` }),
  )
  attempt(() => setWorkspaceFolderName(doc, { path: 'a/b', name: sentence(rng, 2) }))
  if (i % 2 === 0) attempt(() => setWorkspaceFolderName(doc, { path: 'a', name: undefined }))
  setWorkspaceDocumentName(doc, { documentId: ulid(docCounter), name: sentence(rng, 2) })
  add('ws-folder-names', 'workspace', doc)
}
for (let i = 0; i < 6; i++) {
  const rng = rngOf(2300 + i)
  const doc = peer(new LoroDoc(), 1)
  const ids = seedTree(doc, rng, 4, false)
  setWorkspaceLastCompactedAt(doc, 1000 * (i + 1))
  for (const id of ids.slice(0, 3)) setWorkspacePinned(doc, id, true)
  if (ids[0] !== undefined && i % 2 === 0) setWorkspacePinned(doc, ids[0], false)
  add('ws-meta-pins', 'workspace', doc)
}
for (let i = 0; i < 6; i++) {
  const rng = rngOf(2400 + i)
  const doc = peer(new LoroDoc(), 1)
  const ids = seedTree(doc, rng, 3, true)
  for (const [k, id] of ids.entries()) {
    recordTrashEntry(doc, {
      documentId: id,
      path: `gone/${k}`,
      ...(k % 2 === 0 ? { name: sentence(rng, 2) } : {}),
      ...(k === 0 ? { folderNames: [{ path: 'gone', name: 'Gone' }] } : {}),
      deletedAt: 5000 + k,
      blob: { algorithm: 'sha-256', digestHex: 'ab'.repeat(32) },
    })
  }
  add('ws-trash', 'workspace', doc)
}
for (let i = 0; i < 20; i++) {
  const rng = rngOf(2500 + i)
  const doc = peer(new LoroDoc(), 1)
  seedTree(doc, rng, int(rng, 1, 5), true)
  add('ws-hosted-content', 'workspace', doc)
}
for (let i = 0; i < 18; i++) {
  const rng = rngOf(2600 + i)
  const a = peer(new LoroDoc(), 21)
  const ids = seedTree(a, rng, 3, i % 2 === 0)
  const since = a.oplogVersion()
  const b = peer(new LoroDoc(), 22)
  b.import(a.export({ mode: 'snapshot' }))
  seedTree(b, rngOf(2650 + i), 2, true)
  const first = ids[0]
  if (first !== undefined) {
    setWorkspaceDocumentName(a, { documentId: first, name: sentence(rng, 2) })
    attempt(() => writeMarkdownBody(documentContainers(a, first), `${body(rng, true)}`))
  }
  moveWorkspaceNodeToPath(b, 'notes', 'archive/notes')
  // both peers create the same path: two nodes, one path
  createWorkspaceDocumentAtPath(a, {
    path: 'dup/page',
    documentId: nextId(),
    kind: 'markdown',
    createdAt: 1,
    updatedAt: 1,
  })
  createWorkspaceDocumentAtPath(b, {
    path: 'dup/page',
    documentId: nextId(),
    kind: 'markdown',
    createdAt: 1,
    updatedAt: 1,
  })
  a.import(b.export({ mode: 'update', from: a.oplogVersion() }))
  b.import(a.export({ mode: 'update', from: b.oplogVersion() }))
  add('ws-concurrent', 'workspace', a, since)
}
for (let i = 0; i < 4; i++) {
  const doc = peer(new LoroDoc(), 1)
  createWorkspaceDocumentAtPath(doc, {
    path: 'folder/page',
    documentId: nextId(),
    kind: 'markdown',
    createdAt: 1,
    updatedAt: 1,
  })
  const tampers: Array<[string, string, string]> = [
    ['folder', 'icon', 'open'],
    ['page', 'kind', 'future-kind'],
    ['page', 'createdAt', 'not-a-number'],
    ['page', 'segment', ''],
  ]
  const [segment, key, value] = tampers[i] as [string, string, string]
  for (const node of doc.getTree('tree').getNodes()) {
    if ((node.data.toJSON() as { segment?: string }).segment === segment) node.data.set(key, value)
  }
  doc.commit()
  add('ws-unreadable', 'workspace', doc)
}
for (let i = 0; i < 40; i++) {
  const rng = rngOf(3000 + i)
  const doc = peer(new LoroDoc(), 1)
  let since = doc.oplogVersion()
  const ids = seedTree(doc, rng, int(rng, 2, 6), rng() < 0.5)
  since = rng() < 0.7 ? doc.oplogVersion() : since
  for (let step = 0; step < int(rng, 2, 8); step++) {
    const id = pick(rng, ids)
    switch (int(rng, 0, 5)) {
      case 0:
        if (id !== undefined) deleteWorkspaceDocument(doc, { documentId: id })
        break
      case 1:
        moveWorkspaceNodeToPath(
          doc,
          pick(rng, ['notes', 'boards', 'a', 'x']),
          `moved/${pick(rng, WORDS)}${step}`,
        )
        break
      case 2:
        if (id !== undefined)
          attempt(() => setWorkspaceDocumentName(doc, { documentId: id, name: sentence(rng, 2) }))
        break
      case 3:
        if (id !== undefined) setWorkspacePinned(doc, id, rng() < 0.7)
        break
      case 4:
        attempt(() =>
          setWorkspaceFolderName(doc, {
            path: pick(rng, ['notes', 'a', 'a/b', 'x']),
            name: sentence(rng, 2),
          }),
        )
        break
      default:
        if (id !== undefined) attempt(() => anyContent(documentContainers(doc, id), doc, rng))
    }
  }
  add('ws-random', 'workspace', doc, since)
}

// ---- recording ----

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

const differing = (value: unknown, base: unknown) =>
  JSON.stringify(value) === JSON.stringify(base) ? null : value

async function record(spec: Spec): Promise<string> {
  const { doc } = spec
  doc.commit()
  // Every figure is read off a fresh import of the bytes, before any reader runs.
  // A writer or reader that names a root container opens it, and a snapshot carries
  // that opened-but-empty root while an update export does not, so the three
  // exports of one document answer different deep values and each is recorded.
  const exported = {
    snapshot: doc.export({ mode: 'snapshot' }),
    updates: doc.export({ mode: 'update' }),
    shallow: doc.export({ mode: 'shallow-snapshot', frontiers: doc.frontiers() }),
  }
  const fresh = (bytes: Uint8Array) => {
    const out = new LoroDoc()
    out.import(bytes)
    return out
  }
  const imports = {
    snapshot: fresh(exported.snapshot),
    updates: fresh(exported.updates),
    shallow: fresh(exported.shallow),
  }
  const stored0 = imports.updates
  const stored = {
    snapshot: b64(exported.snapshot),
    updates: b64(exported.updates),
    shallow: b64(exported.shallow),
    // The update import is the oplog's own state; a snapshot or shallow import is
    // recorded only where it answers differently (an opened-but-empty root).
    deep: {
      updates: imports.updates.toJSON(),
      snapshot: differing(imports.snapshot.toJSON(), imports.updates.toJSON()),
      shallow: differing(imports.shallow.toJSON(), imports.updates.toJSON()),
    },
    ids: imports.updates.getDeepValueWithID(),
    vv: versionPairs(stored0.oplogVersion()),
    frontiers: frontierPairs(stored0.frontiers()),
  }
  const since = spec.sinceVersion ?? new LoroDoc().oplogVersion()
  const readers: Record<string, unknown> =
    spec.host === 'workspace'
      ? await workspaceReaders(stored0, since)
      : rootDocumentReaders(stored0)
  return JSON.stringify({
    id: spec.id,
    shape: spec.shape,
    host: spec.host,
    since: versionPairs(since),
    ...stored,
    readers: JSON.parse(JSON.stringify(readers)),
  })
}

const lines: string[] = []
for (const spec of specs) lines.push(await record(spec))
writeFileSync(OUT, `${lines.join('\n')}\n`)
console.log(`wrote ${lines.length} rows to ${OUT}`)
