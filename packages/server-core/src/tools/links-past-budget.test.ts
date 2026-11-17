// REFERENCE_BUDGET bounds what a render LOADS, not what it may NAME: a link
// the workspace index can resolve needs no read of the target, so the
// daemon's renders draw link 300 the way they draw link 1 — a titled link to
// the target's id — rather than as the raw `[[...]]` the author wrote.

import { referenceTargets } from '@kamiazya/whiteboard-canvas-render'
import {
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { FakeDocumentStore, placeUnlessPlaced, seedDoc } from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createCanvasRenderSvgTool } from './canvas-render-svg.js'
import { createCanvasViewTool } from './canvas-view.js'
import { canvasViewPicture } from './canvas-view-picture.js'

const WORKSPACE_ID = '01ZVM89A4A1V9FS03Z9J64KEK1'
const SOURCE_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const COUNT = 300
const idOf = (i: number) => `01BX5ZZKBKACTAV9WEVG${String(i).padStart(6, '0')}`
const LINKS = Array.from({ length: COUNT }, (_, i) => `[[note-${i}]]`).join(' ')
/** How many of LINKS a render loads: the first link past it is never read. */
const LOADED = referenceTargets({ bodies: [LINKS] }).length

/** The source document, plus COUNT indexed targets `note-i` named `Note i`. */
async function workspace(write: (doc: LoroDoc) => void) {
  const store = new FakeDocumentStore()
  for (let i = 0; i < COUNT; i++) {
    store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      path: `note-${i}`,
      documentId: idOf(i),
      kind: 'markdown',
      name: `Note ${i}`,
    })
  }
  await placeUnlessPlaced(store, WORKSPACE_ID, SOURCE_ID)
  await seedDoc(store, SOURCE_ID, write)
  return makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
}

function expectEveryLinkTitled(svg: string) {
  // The premise: some links lie past what the walk loads.
  expect(LOADED).toBeLessThan(COUNT)
  for (const i of [0, LOADED, COUNT - 1]) {
    expect(svg).toContain(`href="${idOf(i)}"`)
    expect(svg).toContain(`>Note ${i}<`)
  }
  expect(svg).not.toContain('[[note-')
}

describe('links past the reference loading budget', () => {
  test('wb_scene_render draws every link of a note titled, the 300th as the 1st', async () => {
    const deps = await workspace((doc) => {
      writeDocumentKind(doc, 'markdown')
      writeMarkdownBody(doc, `${LINKS}\n`)
    })
    const { svg } = await createCanvasRenderSvgTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: SOURCE_ID,
      embedReferences: true,
      comments: false,
      style: 'clean',
    })
    expectEveryLinkTitled(svg)
  })

  test('canvas_view draws every link a text node writes titled', async () => {
    const deps = await workspace((doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, {
        nodes: [textNode({ id: 't', x: 0, y: 0, width: 4000, height: 4000, text: LINKS })],
        edges: [],
      })
    })
    const result = await createCanvasViewTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: SOURCE_ID,
    })
    const { svg } = await canvasViewPicture(deps, result)
    expectEveryLinkTitled(svg)
  })
})
