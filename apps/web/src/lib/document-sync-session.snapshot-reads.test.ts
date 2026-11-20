/**
 * What a session answers the moment its keeper's snapshot has been delivered,
 * with no timer fired and no microtask turned. The editor mounts on these
 * reads in the same task that delivers the snapshot, so a read that became
 * asynchronous would show an empty document first.
 */

import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  setEdgeLock,
  setNodeLock,
  writeCoreFacets,
  writeFacets,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { openTestSession } from '../test-utils/document-sync-session.js'

const DOC = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

const CANVAS = {
  nodes: [
    textNode({ id: 'n-a', x: 0, y: 0, width: 100, height: 50, text: 'a' }),
    textNode({ id: 'n-b', x: 200, y: 0, width: 100, height: 50, text: 'b' }),
  ],
  edges: [],
}

function record(
  kind: 'markdown' | 'spatial',
  fill: (content: ReturnType<typeof documentContainers>) => void,
) {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'notes', documentId: DOC, kind, name: 'Meeting' })
  fill(documentContainers(doc, DOC))
  doc.commit()
  return doc.export({ mode: 'snapshot' })
}

describe('a session reading its document straight after the snapshot is delivered', () => {
  it('answers a markdown document’s body, name, facets and history at once', () => {
    const s = openTestSession({
      deps: { contentDocumentId: DOC },
    })
    expect(s.session.getMarkdownBody()).toBe('')
    expect(s.session.getDocumentName()).toBeUndefined()

    s.handlers().onSnapshot(
      record('markdown', (content) => {
        writeMarkdownBody(content, '# Notes\n\nhello')
        writeCoreFacets(content, { type: 'note', tags: ['x'] })
        writeFacets(content, { 'plugin.example/v1': { a: 1 } })
      }),
    )

    expect(s.session.getMarkdownBody()).toBe('# Notes\n\nhello')
    expect(s.session.getDocumentName()).toBe('Meeting')
    expect(s.session.getCoreFacets()).toEqual({ type: 'note', tags: ['x'] })
    expect(s.session.getFacets()).toEqual({ 'plugin.example/v1': { a: 1 } })
    expect(s.session.getBodyBinding()).not.toBeNull()
    expect([s.session.canUndo(), s.session.canRedo()]).toEqual([false, false])
    expect(typeof s.session.getContentState()).toBe('string')
    expect(s.session.exportSnapshot()).toBeInstanceOf(Uint8Array)
    s.session.dispose()
  })

  it('answers a canvas document’s canvas, locks, name and layers at once', () => {
    const s = openTestSession({ deps: { contentDocumentId: DOC } })
    expect(s.session.getCanvas()).toEqual({ nodes: [], edges: [] })

    s.handlers().onSnapshot(
      record('spatial', (content) => {
        writeSpatialCanvas(content, CANVAS)
        setNodeLock(content, 'n-a', true)
        setEdgeLock(content, 'e-1', true)
      }),
    )

    expect(s.session.getCanvas()).toEqual(CANVAS)
    expect([...s.session.getNodeLocks()]).toEqual(['n-a'])
    expect([...s.session.getEdgeLocks()]).toEqual(['e-1'])
    expect(s.session.getDocumentName()).toBe('Meeting')
    expect(s.session.getCoreFacets()).toBeUndefined()
    expect(s.session.getAnnotations()).toEqual([])
    expect(s.session.getProposals()).toEqual([])
    expect(s.session.getThreadMarks().size).toBe(0)
    expect([s.session.canUndo(), s.session.canRedo()]).toEqual([false, false])
    expect(typeof s.session.getContentState()).toBe('string')
    expect(s.session.exportSnapshot()).toBeInstanceOf(Uint8Array)
    s.session.dispose()
  })

  it('tells a body subscriber and a lock subscriber of the hydration before the delivery returns', () => {
    const s = openTestSession({ deps: { contentDocumentId: DOC } })
    const heard: string[] = []
    s.session.subscribeMarkdownBody(() => heard.push('body'))
    s.session.subscribeLocks(() => heard.push('locks'))
    s.session.subscribe((_canvas, origin) => heard.push(`canvas:${origin}`))

    s.handlers().onSnapshot(record('markdown', (content) => writeMarkdownBody(content, 'hi')))

    expect(heard).toEqual(['canvas:external', 'locks', 'body'])
    s.session.dispose()
  })
})
