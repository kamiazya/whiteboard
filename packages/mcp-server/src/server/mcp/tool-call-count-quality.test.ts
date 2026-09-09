// The tool-call scoreboard.
//
// "Bring the number of tool calls down" is a claim about a NUMBER, and until
// this ran nothing counted it. Each errand is a realistic task driven against
// a REAL McpServer over an in-memory transport — the SDK's own argument
// validation judges every payload, so a count here is what a client actually
// pays rather than what a design says it should.
//
// CALLS is the debt and it targets down. BYTES is the price and has no
// target: a consolidation that halves the calls by sending one enormous
// payload has moved the cost rather than removed it, and the pair is what
// says which happened.
//
// The numbers are pinned EXACTLY. An improvement has to be as loud as a
// regression, because the point is that someone says why it moved.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { MCP_ERRAND_CORPUS } from '../../shared/test-utils/mcp-errand-corpus.js'
import { makeSpatialDoc } from '../../shared/test-utils/spatial-doc.js'
import { InMemoryDocumentStore } from '../store/inmemory/in-memory-document-store.js'
import { registerDocumentTools } from './document-tools.js'

const WORKSPACE_ID = 'ws-count'
const SEED_CANVAS: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 120, height: 60, text: 'seeded' }],
  edges: [],
}

/** ULIDs are 26 chars of Crockford base32; these only have to be distinct. */
const seedId = (index: number): string => `01H8XJZ9K5N4M3P2Q1R0S9T${String(index).padStart(3, '0')}`

interface Tally {
  calls: number
  requestBytes: number
  responseBytes: number
}

async function harness(seedDocuments: number): Promise<{
  client: Client
  documentIds: string[]
  tally: Tally
}> {
  const documentStore = new InMemoryDocumentStore()
  const documentIndex = new InMemoryDocumentIndex()
  const documentIds: string[] = []
  for (let i = 0; i < seedDocuments; i += 1) {
    const documentId = seedId(i)
    documentIds.push(documentId)
    documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId,
      path: `doc-${i}`,
      kind: 'spatial',
    })
    const doc = makeSpatialDoc(SEED_CANVAS)
    const { manifest, chunks } = chunkSnapshot(doc.export({ mode: 'snapshot' }), 1_000_000)
    await documentStore.saveSnapshot({
      docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId },
      manifest,
      chunks,
      frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
    })
  }

  const server = new McpServer({ name: 'whiteboard-call-count', version: '0.0.0' })
  registerDocumentTools(server, { documentStore, blobStore: {} as never, documentIndex })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'call-count', version: '0.0.0' })
  await client.connect(clientSide)

  // Counting by WRAPPING the client, so an errand cannot forget to report a
  // call it made: every round trip goes through here or it does not happen.
  const tally: Tally = { calls: 0, requestBytes: 0, responseBytes: 0 }
  const inner = client.callTool.bind(client)
  const counting = async (...args: Parameters<typeof inner>) => {
    tally.calls += 1
    tally.requestBytes += JSON.stringify(args[0]).length
    const result = await inner(...args)
    tally.responseBytes += JSON.stringify(result).length
    return result
  }
  ;(client as unknown as { callTool: typeof counting }).callTool = counting

  return { client, documentIds, tally }
}

async function score(name: string): Promise<Tally> {
  const errand = MCP_ERRAND_CORPUS.find((entry) => entry.name === name)
  if (errand === undefined) throw new Error(`no errand named ${name}`)
  const { client, documentIds, tally } = await harness(errand.seedDocuments)
  await errand.run({ client, workspaceId: WORKSPACE_ID, documentIds })
  return tally
}

describe('what an errand costs in tool calls', () => {
  // A count beside the scoreboard: an errand that silently stopped calling
  // anything would otherwise report itself as the cheapest of all.
  it('makes at least one call per errand', async () => {
    for (const errand of MCP_ERRAND_CORPUS) {
      expect((await score(errand.name)).calls, errand.name).toBeGreaterThan(0)
    }
  })

  it('scores every errand', async () => {
    const scores: Record<string, Tally> = {}
    for (const errand of MCP_ERRAND_CORPUS) {
      scores[errand.name] = await score(errand.name)
    }
    expect(scores).toEqual({
      // Axis A, and the shape to copy: fourteen elements of a drawing cost
      // ONE edit, because `wb_canvas_edit` takes an `ops` array. The other
      // call is the create.
      'author a canvas of 8 nodes and 6 edges': {
        calls: 2,
        requestBytes: 1500,
        responseBytes: 3066,
      },
      // Axis B on a read, now consolidated. `wb_document_list` answers with
      // METADATA only — id, path, name, kind, updatedAt, shadowed — so the
      // CONTENT of five documents still needs a second call; it no longer
      // needs five, because `wb_document_get` takes `documentIds`.
      //
      // Read the pair, not the calls alone. Calls 6 -> 2 and request bytes
      // 601 -> 292, but response bytes went UP, 3042 -> 3310: each entry now
      // names its own `documentId`, which five separate replies never had to
      // say. +268 bytes for -4 round trips is the trade this consolidation
      // actually makes, and it is worth stating rather than reporting the
      // calls alone as a clean win.
      'read every document in a workspace of 5': {
        calls: 2,
        requestBytes: 292,
        responseBytes: 3310,
      },
      // Axis B on a write. One facet write per document, because
      // `wb_facet_set` takes a single `documentId`.
      'tag 5 documents': {
        calls: 5,
        requestBytes: 735,
        responseBytes: 1135,
      },
      // Axis B on a different verb, which is the point of having it: the
      // cost tracks the number of SUBJECTS, not anything about facets.
      'save a labelled version of 4 documents': {
        calls: 4,
        requestBytes: 532,
        responseBytes: 424,
      },
    })
  })
})
