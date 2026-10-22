import { writeDocumentKind, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { documentIdSchema, NODE_TEXT_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { extractContentFacts } from './extract.js'
import { backlinksIn } from './reference-aggregate.js'

// Counts every excerpt a backlinks answer cuts, without changing what it cuts.
const excerpts = vi.hoisted(() => ({ built: 0 }))
vi.mock('@kamiazya/whiteboard-search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kamiazya/whiteboard-search')>()
  return {
    ...actual,
    snippetAround: (...args: Parameters<typeof actual.snippetAround>) => {
      excerpts.built++
      return actual.snippetAround(...args)
    },
  }
})

const SOURCE = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const TARGET = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const UNRELATED = '01CX5ZZKBKACTAV9WEVGEMMVRZ'

// One board of text nodes, each filled to the node-text ceiling with the
// shortest reference there is. A full board is 2000 nodes; a tenth of one
// keeps the fixture's heap reasonable while the counts scale linearly.
const NODES = 200
const PER_NODE = Math.floor(NODE_TEXT_MAX_CHARS / '[[t]]'.length)
const REFS = NODES * PER_NODE

const entries = [
  { documentId: SOURCE, path: 'board', kind: 'spatial' as const },
  { documentId: TARGET, path: 't', kind: 'markdown' as const },
  { documentId: UNRELATED, path: 'u', kind: 'markdown' as const },
]

let content: Map<string, ReturnType<typeof extractContentFacts>>

beforeAll(() => {
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'spatial')
  writeSpatialCanvas(doc, {
    nodes: Array.from({ length: NODES }, (_, i) =>
      textNode({ id: `n${i}`, x: 0, y: 0, width: 10, height: 10, text: '[[t]]'.repeat(PER_NODE) }),
    ),
    edges: [],
  })
  content = new Map([[SOURCE, extractContentFacts({ kind: 'spatial' }, doc)]])
})

afterEach(() => {
  vi.restoreAllMocks()
  excerpts.built = 0
})

function measure(documentId: string) {
  // A counting wrapper rather than a spy: a spy records every call's
  // arguments, which at this size costs more than the work it counts.
  let parses = 0
  const real = documentIdSchema.safeParse.bind(documentIdSchema)
  vi.spyOn(documentIdSchema, 'safeParse').mockImplementation(((value: unknown) => {
    parses++
    return real(value)
  }) as typeof documentIdSchema.safeParse)
  const start = performance.now()
  const answer = backlinksIn(entries as never, content, documentId)
  const elapsed = performance.now() - start
  return { answer, parses, excerpts: excerpts.built, elapsed }
}

describe('what one backlinks request costs against a board dense with references', () => {
  it('the fixture holds every reference the board was written with', () => {
    expect(content.get(SOURCE)?.refs).toHaveLength(REFS)
  })

  it('a request for the referenced document', { timeout: 60_000 }, () => {
    const { answer, parses, excerpts: built, elapsed } = measure(TARGET)
    // Measured: one excerpt and one id-schema parse per reference, so the
    // answer carries 327,600 excerpts for this tenth of a board; ~7.1s.
    expect(answer.backlinks[0]?.contexts).toHaveLength(REFS)
    expect(built).toBe(REFS)
    expect(parses).toBe(REFS)
    expect(elapsed).toBeGreaterThan(0)
  })

  it('a request for a document nothing references', { timeout: 60_000 }, () => {
    const { answer, parses, excerpts: built } = measure(UNRELATED)
    // Measured: every reference in the workspace is classified again, and a
    // failing id parse is the expensive half; ~6.1s for this tenth of a
    // board, so ~60s for a full one, on a request about anything else.
    expect(answer.backlinks).toEqual([])
    expect(built).toBe(0)
    expect(parses).toBe(REFS)
  })
})
