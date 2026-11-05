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
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { SceneNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { type LoadedReference, layoutMdastBlocks, referenceSeams } from '../index.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { layoutSpatialCanvas } from './spatial-canvas.js'

const BOARD = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const COMMENT = 'should we add snow here'

const board: SpatialCanvas = {
  nodes: [textNode({ id: 'b1', x: 0, y: 0, width: 300, height: 120, text: 'Evaporation' })],
  edges: [],
  comments: [{ id: 'c1', x: 320, y: 40, text: COMMENT }],
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

describe('a canvas embedded in another document draws no comment layer', () => {
  it('draws the comment on the board itself, so the fixture has one to hide', () => {
    const drawn = walk(layoutSpatialCanvas(board, base).nodes)
    expect(drawn.chrome).toBeGreaterThan(0)
    expect(drawn.text.join(' ')).toContain('snow')
  })

  it('leaves it out of a note embedding the board', () => {
    const body: MdastRoot = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'embed', documentId: BOARD }] }],
    }
    const scene = layoutMdastBlocks(body, {
      measure: createFakeMeasure(),
      maxWidth: 600,
      fontFamily: 'sans-serif',
      references,
    })
    const drawn = walk(scene.nodes)
    expect(drawn.text).toContain('Evaporation')
    expect(drawn.chrome).toBe(0)
    expect(drawn.text.join(' ')).not.toContain('snow')
  })

  it('leaves it out of a text node embedding the board', () => {
    const host: SpatialCanvas = {
      nodes: [textNode({ id: 't', x: 0, y: 0, width: 600, height: 400, text: `![[${BOARD}]]` })],
      edges: [],
    }
    const drawn = walk(layoutSpatialCanvas(host, { ...base, references }).nodes)
    expect(drawn.text).toContain('Evaporation')
    expect(drawn.chrome).toBe(0)
    expect(drawn.text.join(' ')).not.toContain('snow')
  })

  it('leaves it out of a file node showing the board', () => {
    const host: SpatialCanvas = {
      nodes: [fileNode({ id: 'f', x: 0, y: 0, width: 600, height: 400, file: BOARD })],
      edges: [],
    }
    const drawn = walk(
      layoutSpatialCanvas(host, { ...base, references, expandFileNode: () => true }).nodes,
    )
    expect(drawn.text).toContain('Evaporation')
    expect(drawn.chrome).toBe(0)
    expect(drawn.text.join(' ')).not.toContain('snow')
  })

  it('keeps the host canvas’s own comments', () => {
    const host: SpatialCanvas = {
      nodes: [fileNode({ id: 'f', x: 0, y: 0, width: 600, height: 400, file: BOARD })],
      edges: [],
      comments: [{ id: 'h1', x: 700, y: 40, text: 'host remark' }],
    }
    const drawn = walk(
      layoutSpatialCanvas(host, { ...base, references, expandFileNode: () => true }).nodes,
    )
    expect(drawn.text.join(' ')).toContain('remark')
    expect(drawn.text.join(' ')).not.toContain('snow')
  })
})
