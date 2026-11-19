import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type CanvasEdge,
  type CanvasLine,
  coreFacetsSchema,
  type Proposal,
  proposalSchema,
  type SpatialCanvas,
  trustFacetsSchema,
} from '@kamiazya/whiteboard-model'
import {
  arbitraryForSchema,
  canvasLineArbitrary,
  commentThreadArbitrary,
  groupNode,
  spatialCanvasArbitrary,
  textNode,
} from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { writeCommentThread, writeThreadMessage } from '../src/comment-threads.js'
import { writeCoreFacets, writeDocumentKind, writeTrustFacets } from '../src/document-envelope.js'
import { writeSpatialCanvas } from '../src/loro-bridge.js'
import { writeMarkdownBody } from '../src/markdown-body.js'
import { writeProposal } from '../src/proposals.js'
import { createWorkspaceDocumentAtPath, documentContainers } from '../src/workspace-tree.js'
import {
  attempt,
  body,
  peer,
  pick,
  type Rng,
  sample,
  sentence,
  ulid,
  WIDE,
  WORDS,
} from './oracle-recorder-kit.js'

const here = dirname(fileURLToPath(import.meta.url))
const _OUT = join(here, '..', 'src', 'oracle', 'crdt-write.jsonl')

const _b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const _fromB64 = (text: string) => {
  const doc = new LoroDoc()
  doc.import(new Uint8Array(Buffer.from(text, 'base64')))
  return doc
}

// ---- befores ----

export type ContentKind = 'empty' | 'spatial' | 'markdown' | 'threads' | 'proposals' | 'envelope'

export interface Facts {
  canvas?: SpatialCanvas
  text?: string
  threadIds: string[]
  proposals: Proposal[]
}

export interface Scene {
  doc: LoroDoc
  host: 'document' | 'workspace'
  /** Set when the document under test is a tree node of `doc`. */
  documentId?: string
  facts: Facts
}

export const KINDS = ['markdown', 'spatial'] as const
let docCounter = 0
export const nextId = () => ulid(++docCounter % 1000)

type Host = Parameters<typeof writeSpatialCanvas>[0]

function fillSpatial(host: Host, rng: Rng, facts: Facts) {
  const [drawn] = sample(spatialCanvasArbitrary, rng, 1)
  const lines: CanvasLine[] = sample(canvasLineArbitrary, rng, 1)
  const base = drawn ?? { nodes: [], edges: [] }
  // The two nodes added last always exist, so an edge between them is never absent.
  const edges: CanvasEdge[] =
    base.edges.length === 0 ? [{ id: 'e1', from: { node: 'g1' }, to: { node: 't1' } }] : base.edges
  const canvas = {
    ...base,
    edges,
    nodes: [
      ...base.nodes.filter((n) => n.id !== 'g1' && n.id !== 't1'),
      groupNode({ id: 'g1', x: 0, y: 0, width: 400, height: 300, label: sentence(rng, 2) }),
      textNode({ id: 't1', x: 10, y: 10, width: 120, height: 60, text: pick(rng, WIDE) }),
    ],
    ...(rng() < 0.5 ? { lines } : {}),
  }
  attempt(() => writeSpatialCanvas(host, canvas))
  attempt(() => writeDocumentKind(host, 'spatial'))
  facts.canvas = canvas
}

function fillEnvelope(host: Host, rng: Rng) {
  const [core] = sample(arbitraryForSchema(coreFacetsSchema), rng, 1)
  const [trust] = sample(arbitraryForSchema(trustFacetsSchema), rng, 1)
  if (core !== undefined) {
    const { title: _title, ...stored } = core
    attempt(() => writeCoreFacets(host, stored))
  }
  if (trust !== undefined) attempt(() => writeTrustFacets(host, trust))
}

function fillMarkdown(host: Host, content: ContentKind, rng: Rng, facts: Facts) {
  attempt(() => writeDocumentKind(host, 'markdown'))
  const text = body(rng, rng() < 0.5)
  writeMarkdownBody(host, text)
  facts.text = text
  if (content === 'threads') {
    const threads = sample(commentThreadArbitrary, rng, 2)
    threads.forEach((thread, i) => {
      attempt(() => writeCommentThread(host, { ...thread, id: `t${i}` }))
      facts.threadIds.push(`t${i}`)
    })
    attempt(() => writeThreadMessage(host, 't0', { id: 'm-late', body: sentence(rng, 3) }))
  } else if (content === 'proposals') {
    const proposals = sample(arbitraryForSchema(proposalSchema), rng, 2)
    proposals.forEach((proposal: Proposal, i) => {
      const named = { ...proposal, id: `p${i}` }
      attempt(() => writeProposal(host, named))
      facts.proposals.push(named)
    })
  } else if (content === 'envelope') {
    fillEnvelope(host, rng)
  }
}

export function fillContent(host: Host, content: ContentKind, rng: Rng): Facts {
  const facts: Facts = { threadIds: [], proposals: [] }
  if (content === 'spatial') fillSpatial(host, rng, facts)
  else if (content !== 'empty') fillMarkdown(host, content, rng, facts)
  return facts
}

export function documentScene(content: ContentKind, rng: Rng): Scene {
  const doc = peer(new LoroDoc(), 1)
  const facts = fillContent(doc, content, rng)
  return { doc, host: 'document', facts }
}

/** A workspace holding a few documents; the first carries `content`. */
export function workspaceScene(content: ContentKind, rng: Rng): Scene {
  const doc = peer(new LoroDoc(), 1)
  const ids = seedTree(doc, rng, 3)
  const documentId = ids[0]?.id
  const facts =
    documentId === undefined
      ? { threadIds: [], proposals: [] }
      : fillContent(documentContainers(doc, documentId), content, rng)
  return { doc, host: 'workspace', ...(documentId === undefined ? {} : { documentId }), facts }
}

const FOLDERS = ['notes', 'boards', 'archive', 'a/b']

export function seedTree(
  doc: LoroDoc,
  rng: Rng,
  count: number,
): Array<{ id: string; path: string; kind: 'markdown' | 'spatial' }> {
  const made: Array<{ id: string; path: string; kind: 'markdown' | 'spatial' }> = []
  for (let k = 0; k < count; k++) {
    // The first two sit at the path a new-document flow generates, the only one a heading may name.
    const leaf = k === 0 ? 'untitled' : k === 1 ? 'untitled-2' : `${pick(rng, WORDS)}${k}`
    const path = `${k === 0 ? 'notes/' : `${pick(rng, FOLDERS)}/`}${leaf}`
    const id = nextId()
    const kind = pick(rng, KINDS)
    const created = createWorkspaceDocumentAtPath(doc, {
      path,
      documentId: id,
      kind,
      createdAt: 1000 + k,
      updatedAt: 1000 + k,
      ...(k >= 2 && rng() < 0.4 ? { name: `${pick(rng, WORDS)} ${k}` } : {}),
    })
    if (created !== null) made.push({ id, path, kind })
  }
  return made
}

export function seedTreeIds(scene: Scene): Array<{ id: string; path: string }> {
  return scene.doc
    .getTree('tree')
    .getNodes()
    .flatMap((node) => {
      const data = node.data.toJSON() as { documentId?: string; segment?: string }
      const segments: string[] = []
      for (let at: typeof node | undefined = node; at !== undefined; at = at.parent()) {
        segments.unshift(String(at.data.get('segment')))
      }
      return data.documentId === undefined
        ? []
        : [{ id: data.documentId, path: segments.join('/') }]
    })
}
