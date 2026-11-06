/**
 * A canvas drawn INSIDE another document — a note's `![[board]]`, a text
 * node's `![[board]]`, a file node showing a board — is the board, not the
 * conversation about it. Its comment cards and pins belong on the board's
 * own page; inside an embed they cover the content and travel into a
 * printed handout. The annotation layer of the document being laid out is
 * untouched: only what it embeds is drawn without one.
 */

import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { SceneNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { type LoadedReference, referenceSeams } from '../index.js'
import { threadsOf } from '../test-utils/comment-board.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { layoutSpatialCanvas } from './spatial-canvas.js'

const BOARD = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const COMMENT = 'should we add snow here'

const board: SpatialCanvas = {
  nodes: [textNode({ id: 'b1', x: 0, y: 0, width: 300, height: 120, text: 'Evaporation' })],
  edges: [],
}

const references = referenceSeams(
  new Map<string, LoadedReference>([[BOARD, { documentId: BOARD, name: 'Board', canvas: board }]]),
)

/** Every comment-chrome shape and every run of text, however deep. */
function walk(nodes: readonly SceneNode[]): { chrome: number; text: string[] } {
  let chrome = 0
  const text: string[] = []
  const visit = (node: SceneNode) => {
    const entry = node as {
      kind: string
      text?: string
      commentChrome?: boolean
      runs?: readonly SceneNode[]
      children?: readonly SceneNode[]
    }
    if (entry.commentChrome === true) chrome += 1
    if (entry.kind === 'textRun' && entry.text !== undefined) text.push(entry.text)
    for (const run of entry.runs ?? []) visit(run)
    for (const child of entry.children ?? []) visit(child)
  }
  for (const node of nodes) visit(node)
  return { chrome, text }
}

const base = {
  measure: createFakeMeasure(),
  parseBody: parseMarkdownBody,
  appearance: createSpatialTheme({ mode: 'light' }),
}

/** Comment chrome found BELOW a top-level node — inside what it embeds. */
function nestedCommentChrome(nodes: readonly SceneNode[]): number {
  return nodes.reduce((count, node) => {
    const entry = node as { runs?: readonly SceneNode[]; children?: readonly SceneNode[] }
    return count + walk([...(entry.runs ?? []), ...(entry.children ?? [])]).chrome
  }, 0)
}

describe('a canvas embedded in another document draws none of the host’s comment layer', () => {
  // A board embedded twice, and the host's threads: one about a node only the
  // EMBEDDED board holds — the case where drawing the host's layer inside the
  // embed would land a pin on content the host does not own — and one on a
  // point of the host's own.
  const host: SpatialCanvas = {
    nodes: [
      fileNode({ id: 'f', x: 0, y: 0, width: 600, height: 400, file: BOARD }),
      textNode({ id: 't', x: 0, y: 500, width: 600, height: 400, text: `![[${BOARD}]]` }),
    ],
    edges: [],
  }
  const threads = threadsOf([
    { id: 'k', x: 320, y: 40, text: COMMENT, targetNodeId: 'b1' },
    { id: 'h1', x: 700, y: 40, text: 'host remark' },
  ])
  const laid = () =>
    layoutSpatialCanvas(host, { ...base, references, threads, expandFileNode: () => true }).nodes

  it('draws the host’s own threads, so the fixture has a layer to keep out', () => {
    const drawn = walk(laid())
    expect(drawn.text).toContain('Evaporation')
    expect(drawn.chrome).toBeGreaterThan(0)
    expect(drawn.text.join(' ')).toContain('remark')
  })

  it('draws none of them again inside a file node or a text node showing the board', () => {
    expect(nestedCommentChrome(laid())).toBe(0)
  })
})

/** Proposal chrome found BELOW a top-level node — inside what it embeds. */
function nestedProposalChrome(nodes: readonly SceneNode[]): number {
  let count = 0
  const visit = (node: SceneNode) => {
    const entry = node as {
      proposalChrome?: unknown
      runs?: readonly SceneNode[]
      children?: readonly SceneNode[]
    }
    if (entry.proposalChrome !== undefined) count += 1
    for (const run of entry.runs ?? []) visit(run)
    for (const child of entry.children ?? []) visit(child)
  }
  for (const node of nodes) {
    const entry = node as { runs?: readonly SceneNode[]; children?: readonly SceneNode[] }
    for (const run of entry.runs ?? []) visit(run)
    for (const child of entry.children ?? []) visit(child)
  }
  return count
}

describe('a canvas embedded in another document draws none of the host’s proposals', () => {
  const host: SpatialCanvas = {
    nodes: [
      fileNode({ id: 'f', x: 0, y: 0, width: 600, height: 400, file: BOARD }),
      textNode({ id: 't', x: 0, y: 500, width: 600, height: 400, text: `![[${BOARD}]]` }),
    ],
    edges: [],
  }
  const proposals = [
    {
      id: 'p1',
      createdAt: '2026-09-06T00:00:00.000Z',
      changes: [
        {
          id: 'node:c',
          status: 'open' as const,
          op: 'node.add' as const,
          node: textNode({ id: 'c', x: 40, y: 20, width: 120, height: 60, text: 'C' }),
        },
      ],
    },
  ]

  it('outlines the change on the host and inside neither embed', () => {
    const scene = layoutSpatialCanvas(host, {
      ...base,
      references,
      expandFileNode: () => true,
      proposals,
    })
    const drawn = walk(scene.nodes)
    expect(drawn.text.filter((each) => each === 'Evaporation')).toHaveLength(2)
    expect(scene.nodes.some((node) => (node as { id?: string }).id === 'node:c/outline')).toBe(true)
    expect(nestedProposalChrome(scene.nodes)).toBe(0)
  })
})
