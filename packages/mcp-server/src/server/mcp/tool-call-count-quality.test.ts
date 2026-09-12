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
import { writeCoreFacets, writeDocumentKind, writeFacets } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { VISUAL_STENCILS_KEY } from '@kamiazya/whiteboard-plugin-visual'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { STENCIL_LIBRARY_PATH } from '@kamiazya/whiteboard-server-core'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { InMemoryVersionHistory } from '../../shared/test-utils/in-memory-version-history.js'
import { type Errand, MCP_ERRAND_CORPUS } from '../../shared/test-utils/mcp-errand-corpus.js'
import { makeSpatialDoc } from '../../shared/test-utils/spatial-doc.js'

/** A markdown note with the frontmatter a tag needs somewhere to live. */
function makeMarkdownDoc(): LoroDoc {
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'markdown')
  writeCoreFacets(doc, { type: 'note', tags: ['seeded'] })
  doc.commit()
  return doc
}

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

async function harness(
  seedDocuments: number,
  seedKind: 'spatial' | 'markdown' = 'spatial',
  seedStencilLibrary?: Errand['seedStencilLibrary'],
): Promise<{
  client: Client
  documentIds: string[]
  tally: Tally
}> {
  const documentStore = new InMemoryDocumentStore()
  const documentIndex = new InMemoryDocumentIndex()
  const documentIds: string[] = []
  const save = async (documentId: string, doc: LoroDoc) => {
    const { manifest, chunks } = chunkSnapshot(doc.export({ mode: 'snapshot' }), 1_000_000)
    await documentStore.saveSnapshot({
      docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId },
      manifest,
      chunks,
      frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
    })
  }
  for (let i = 0; i < seedDocuments; i += 1) {
    const documentId = seedId(i)
    documentIds.push(documentId)
    documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId,
      path: `doc-${i}`,
      kind: seedKind,
    })
    await save(documentId, seedKind === 'spatial' ? makeSpatialDoc(SEED_CANVAS) : makeMarkdownDoc())
  }
  if (seedStencilLibrary !== undefined) {
    // Seeded, never authored through the tools: a library is a PRECONDITION
    // of the discovery errand, and writing it here would put an earlier
    // conversation's calls into this one's count.
    const libraryId = seedId(900)
    documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: libraryId,
      path: STENCIL_LIBRARY_PATH,
      kind: 'markdown',
    })
    const doc = new LoroDoc()
    writeDocumentKind(doc, 'markdown')
    writeFacets(doc, { [VISUAL_STENCILS_KEY]: { stencils: seedStencilLibrary } } as never)
    doc.commit()
    await save(libraryId, doc)
  }

  const server = new McpServer({ name: 'whiteboard-call-count', version: '0.0.0' })
  registerDocumentTools(server, {
    documentStore,
    blobStore: {} as never,
    documentIndex,
    versions: new InMemoryVersionHistory(),
  } as never)
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
  const { client, documentIds, tally } = await harness(
    errand.seedDocuments,
    errand.seedKind,
    errand.seedStencilLibrary,
  )
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
      //
      // That create is `wb_workspace_edit` now that the standalone
      // `wb_document_create` is retired, and this row is the PRICE of the
      // retirement, measured rather than argued: calls unchanged at 2,
      // request 1500 -> 1532 (+32, the op wrapped in an array), response
      // 3066 -> 3172 (+106, a results list instead of one object). That is
      // what one single create costs to route through the batch, and it is
      // the whole cost — a second document, which used to cost a whole
      // extra call, now costs one more op. The tool table an agent reads
      // first goes 21 -> 18.
      'author a canvas of 8 nodes and 6 edges': {
        calls: 2,
        requestBytes: 1532,
        responseBytes: 3172,
      },
      // A DISCOVERY errand (足場4b): learn what this workspace's own stencil
      // library defines, then wear one of its ids. Two calls, and the id is
      // read out of the first answer rather than known in advance.
      //
      // It replaces a three-call route that was not merely dearer: list the
      // workspace, get the document at `stencils`, parse its frontmatter —
      // reachable only by an agent that already knew a library lives at
      // that path under the key `visual.stencils/v0`, neither of which is
      // written anywhere a model reads.
      //
      // **Read the response bytes, because they are the price and they are
      // not small.** 10,148 for one discovery call: `assetKind: 'stencils'`
      // narrows the ASSETS and deliberately leaves the facets alone, so the
      // answer still carries every registered facet's full JSON Schema.
      // A `facets: false` would cut it, and is NOT worth having — it would
      // add a parameter every model reads on every turn to save bytes on a
      // call most conversations make once, which is the same trade the
      // assets half of this tool already decided the other way. The price
      // is stated here instead.
      //
      // 10,148 -> 11,138, and the attribution matters more than the number:
      // +968 of it is `visual.axes/v0` joining the facet list (ADR-0036 §1),
      // +22 the sixth silhouette in `visual.shape/v0`'s enum. Measured by
      // re-running this pin with each change reverted in turn, because the
      // two landed in different increments and the first one's cost was
      // never re-pinned — this row had been stale on the branch, along with
      // `facet-list.test.ts`, for want of running `mcp-node` on that commit.
      // A facet is exactly what this answer is for, so this is the declared
      // price of declaring one, not a regression.
      'wear a stencil this workspace defines': {
        calls: 2,
        requestBytes: 354,
        responseBytes: 11138,
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
      // Axis B on a write, and the CONTRAST with the read above is the
      // thing to read here. Both went down, hard:
      //
      //   tag 5:   calls 5 -> 1, request 735 -> 266, response 1135 -> 227
      //   save 4:  calls 4 -> 1, request 532 -> 223, response  424 -> 106
      //
      // A bulk READ pays to say which document each answer belongs to, so
      // its bytes went UP. A bulk WRITE with a SHARED payload — one label,
      // one facets object — stops repeating that payload N times and its
      // envelope collapses to one, so its bytes go down with its calls.
      // The shape of the batch decides which happens, not the fact of
      // batching, and that is exactly what the price column is for.
      //
      // Both write rows below were RE-PINNED when the corpus started
      // refusing a refused call: for a week this row measured
      // `facets: { 'core/v1': ... }`, a key the tool never accepted, and the
      // one below measured a `versions` seam the harness never supplied.
      // Both answered a tool error in one call and the count was 1 either
      // way. The bytes are the real writes now — five documents' facets and
      // tags, four version entries — and the tag errand tags MARKDOWN
      // documents through `tags.add`, since a canvas has no frontmatter and
      // the old payload could not have tagged anything even if accepted.
      'tag 5 documents': {
        calls: 1,
        requestBytes: 251,
        responseBytes: 998,
      },
      // The same shape on a different verb, which is the point of having
      // it: the cost tracks the number of SUBJECTS, not anything about
      // facets.
      // Response 1,948 -> 1,316 when the version tools stopped answering
      // the History panel's row (path, counts, thumbnail, the retired
      // branch column) and answered what an agent acts on.
      'save a labelled version of 4 documents': {
        calls: 1,
        requestBytes: 223,
        responseBytes: 1316,
      },
      // Axis A on `region.set`. Request 425 -> 549 when the op stopped
      // taking node declarations and the three boxes became `node.add`
      // ops with `within` plus a member list: +124 bytes on the wire for
      // the op wrappers, against -3,391 on the table every turn reads
      // (see tool-surface-quality). Response 2,060 is unchanged — the
      // placed boxes and the grown group, reported under `geometry`;
      // before growth, this same call at width 700 was refused whole.
      // ADR-0034's stencil field. One call either way — `wb_canvas_edit`
      // batches, so this was never several — and 916 request bytes against
      // 1253 for the same six boxes dressed by hand. The corpus entry
      // carries both numbers and the reason that saving is NOT the case for
      // the field: 480 visible bytes on rung 1 are paid every turn, and 337
      // is saved per errand.
      //
      // Response 2,086 -> 1,918 when the bundled stencils stopped spending
      // colour (ADR-0036 §5): six `color` fields leave the answer and one
      // silhouette joins it, `service` having had none. Nothing was cut for
      // the sake of bytes — this is the by-product of freeing the colour
      // channel for a second semantic axis, and it is stated here so the
      // row is not read as a separate saving.
      'dress six boxes as six kinds': {
        calls: 1,
        requestBytes: 916,
        responseBytes: 1918,
      },
      // 2,060 -> 2,056 when an auto-placed box took the board's own width
      // instead of a flat 260. Four bytes, and what they are worth reading
      // for is what nearly happened instead: this errand's group was 700
      // wide "too narrow for three boxes in a row on purpose", and at the
      // harness's 120-wide seeded box all three suddenly FITTED. The group
      // stopped growing, the errand stopped pricing the growth it exists to
      // price, and the row would have read 1,952 — a 108-byte saving that
      // was really a case no longer reached. The group is 300 now, sized
      // against the board's box width rather than a constant, and the
      // remaining 4 bytes are the grown group's new dimensions.
      'make a group hold exactly three boxes': {
        calls: 1,
        requestBytes: 549,
        responseBytes: 2056,
      },
    })
  })
})
