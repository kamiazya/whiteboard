// @vitest-environment node
import { writeMarkdownBody, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { BrowserVersionStore } from './browser-version-store.js'
import { createBrowserVersionsBackend } from './browser-versions-backend.js'

// A past state as the browser store answers it: content only, so it names no
// kind of its own and carries both halves, as a markdown note's record does.
function pastState(): LoroDoc {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, '# plan')
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 10, height: 10, text: 'hi' })],
    edges: [],
  })
  doc.commit()
  return doc
}

function backendOf(kind: DocumentKind) {
  const store = { loadPast: async () => pastState() } as unknown as BrowserVersionStore
  return createBrowserVersionsBackend({
    store,
    record: { readRecord: () => null, applyRestore: async () => {} },
    kind,
  })
}

describe('the browser versions backend reads a past state as the entry kind says', () => {
  it('answers a markdown entry its body', async () => {
    expect(await backendOf('markdown').loadPast('ws', 'note', 'v1')).toEqual({
      kind: 'markdown',
      body: '# plan',
    })
  })

  it('answers a spatial entry its canvas', async () => {
    const past = await backendOf('spatial').loadPast('ws', 'sketch', 'v1')
    expect(past?.kind).toBe('spatial')
    expect(past?.kind === 'spatial' && past.canvas.nodes.map((node) => node.id)).toEqual(['n1'])
  })
})
