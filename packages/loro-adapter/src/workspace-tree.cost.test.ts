/**
 * Placing a document at a path must cost what the PATH costs, not what the
 * record holds. A client chooses how deep a path is (up to 512 one-character
 * segments inside the path bound) and a keeper's record holds every
 * document's content, so a lookup that reads the whole record once per
 * segment multiplies the two — on the loop that answers every other request.
 *
 * Counted rather than timed: a content copy is a `LoroMap.toJSON` call, and a
 * node read is an access of `LoroTreeNode.data`. Both are what the cost is
 * made of, and neither depends on how fast this machine is.
 */
import { LoroDoc, LoroMap, LoroTreeNode } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { writeMarkdownBody } from './markdown-body.js'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  exportWorkspaceSubtree,
  importWorkspaceSubtree,
  moveWorkspaceNodeToPath,
} from './workspace-tree.js'

const DEEP = 400
const SMALL_RECORD = 4
const LARGE_RECORD = 40
// A ceiling, not a delay: the unbounded form reads the record once per segment.
const COST_TIMEOUT_MS = 120_000

function documentId(index: number): string {
  return `01BRWAAAAAAAAAAAAAAAAA${String(index).padStart(4, '0')}`
}

/** A record holding `count` documents with a body each, all under `seed/`. */
function seededRecord(count: number): LoroDoc {
  const doc = new LoroDoc()
  for (let i = 0; i < count; i++) {
    createWorkspaceDocumentAtPath(doc, {
      path: `seed/doc-${i}`,
      documentId: documentId(i),
      kind: 'markdown',
    })
    writeMarkdownBody(documentContainers(doc, documentId(i)), `# Note ${i}\n\nbody ${i}`)
  }
  return doc
}

/** A path `depth` segments long, none of which the seeded record holds. */
function deepPath(depth: number): string {
  return [...Array.from({ length: depth - 1 }, () => 'x'), 'end'].join('/')
}

interface Cost {
  readonly copies: number
  readonly nodeReads: number
}

/**
 * Counted by wrapping the prototype members by hand rather than through
 * `vi.spyOn`, which records every call's arguments and receiver: the
 * unbounded form makes about a hundred thousand of each.
 */
function measure(run: () => unknown): Cost {
  const toJSON = Object.getOwnPropertyDescriptor(LoroMap.prototype, 'toJSON') as PropertyDescriptor
  const data = Object.getOwnPropertyDescriptor(LoroTreeNode.prototype, 'data') as PropertyDescriptor
  const original = toJSON.value as (this: LoroMap) => unknown
  const read = data.get as (this: LoroTreeNode) => LoroMap
  let copies = 0
  let nodeReads = 0
  Object.defineProperty(LoroMap.prototype, 'toJSON', {
    ...toJSON,
    value(this: LoroMap) {
      copies += 1
      return original.call(this)
    },
  })
  Object.defineProperty(LoroTreeNode.prototype, 'data', {
    ...data,
    get(this: LoroTreeNode) {
      nodeReads += 1
      return read.call(this)
    },
  })
  try {
    run()
    return { copies, nodeReads }
  } finally {
    Object.defineProperty(LoroMap.prototype, 'toJSON', toJSON)
    Object.defineProperty(LoroTreeNode.prototype, 'data', data)
  }
}

const FRESH_ID = '01BRWAAAAAAAAAAAAAAAAAZZZZ'

/** Each placement a keeper performs, against a record of `count` documents at `depth`. */
const PLACEMENTS: Record<string, (count: number, depth: number) => Cost> = {
  create: (count, depth) => {
    const doc = seededRecord(count)
    return measure(() =>
      createWorkspaceDocumentAtPath(doc, {
        path: deepPath(depth),
        documentId: FRESH_ID,
        kind: 'markdown',
      }),
    )
  },
  move: (count, depth) => {
    const doc = seededRecord(count)
    return measure(() => moveWorkspaceNodeToPath(doc, 'seed/doc-0', deepPath(depth)))
  },
  restore: (count, depth) => {
    const trashed = new LoroDoc()
    createWorkspaceDocumentAtPath(trashed, { path: 'gone', documentId: FRESH_ID, kind: 'markdown' })
    const bytes = exportWorkspaceSubtree(trashed, 'gone') as Uint8Array
    const doc = seededRecord(count)
    const parent = deepPath(depth).split('/').slice(0, -1).join('/')
    return measure(() => importWorkspaceSubtree(doc, bytes, parent === '' ? undefined : parent))
  },
}

describe('placing a document at a deep path', () => {
  for (const [name, place] of Object.entries(PLACEMENTS)) {
    it(
      `${name}: copies no more content at depth ${DEEP} than at depth 1`,
      () => {
        const shallow = place(LARGE_RECORD, 1)
        const deep = place(LARGE_RECORD, DEEP)

        expect(shallow.copies).toBeGreaterThan(0)
        expect(deep.copies).toBe(shallow.copies)
      },
      COST_TIMEOUT_MS,
    )

    it(
      `${name}: reads no more nodes per segment in a larger record`,
      () => {
        const perDepth = (count: number) => place(count, DEEP).nodeReads - place(count, 1).nodeReads

        // The subject is present: a deeper path does read more nodes.
        expect(perDepth(SMALL_RECORD)).toBeGreaterThan(DEEP)
        expect(perDepth(LARGE_RECORD)).toBe(perDepth(SMALL_RECORD))
      },
      COST_TIMEOUT_MS,
    )
  }
})
