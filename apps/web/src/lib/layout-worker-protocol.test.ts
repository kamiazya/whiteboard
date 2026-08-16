import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { canLayoutInWorker, composeReferenceSeam } from './layout-worker-protocol.js'

const BODY: MdastRoot = {
  type: 'root',
  children: [{ type: 'paragraph', children: [{ type: 'text', value: 'prose' }] }],
}

const textOnly: SpatialCanvas = {
  nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 60, text: 'hi' }],
  edges: [],
}
const withFile: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 60, text: 'hi' },
    { id: 'f', type: 'file', x: 200, y: 0, width: 100, height: 60, file: 'doc-1' },
  ],
  edges: [],
}
/**
 * One entry per seam the predicate disqualifies on. Listed individually
 * rather than only as a combined object because a combined fixture cannot
 * fail for a seam the predicate FORGOT: with the other clause already
 * returning false, deleting either one leaves every assertion green. That is
 * how a seam was once added to the predicate with no test that could fail —
 * caught in review, pinned here.
 */
const SEAMS: Record<string, unknown> = {
  resolveReferenceContent: () => undefined,
  expandFileNode: () => false,
}

const seams = SEAMS

describe('canLayoutInWorker', () => {
  it('offloads a canvas with no file nodes even when the host supplies file seams', () => {
    // The real pages ALWAYS supply the seams (useCanvasFileSeams returns them
    // unconditionally), so a presence check disables the worker for every
    // production canvas — including the plain text-and-edges ones the seams
    // can never influence. Every seam is keyed on a file reference; a canvas
    // without a file node cannot call one.
    expect(canLayoutInWorker(seams, textOnly)).toBe(true)
  })

  it('stays synchronous when a file node could actually call a seam', () => {
    // A function cannot cross a postMessage, so a canvas whose layout depends
    // on one must fall back rather than silently render without it.
    expect(canLayoutInWorker(seams, withFile)).toBe(false)
  })

  it.each(Object.keys(SEAMS))('stays synchronous for %s supplied alone', (key) => {
    // In isolation, so each clause of the predicate is the ONLY reason the
    // answer is false and deleting it turns exactly this case red.
    expect(canLayoutInWorker({ [key]: SEAMS[key] }, withFile)).toBe(false)
  })

  it('offloads a canvas with file nodes when no seam is supplied', () => {
    expect(canLayoutInWorker({}, withFile)).toBe(true)
  })
})

describe('composeReferenceSeam', () => {
  // The worker and the main thread both build their seam here, so this is
  // the one place the precedence between resolved content and the
  // plain-data chrome is decided.

  it('is absent when nothing is supplied, leaving the layout untouched', () => {
    expect(composeReferenceSeam({})).toBeUndefined()
    expect(composeReferenceSeam({ labels: new Map(), missing: new Set() })).toBeUndefined()
  })

  it('layers a label over resolved content without disturbing the content', () => {
    const seam = composeReferenceSeam({
      content: () => ({ markdown: BODY }),
      labels: new Map([['doc-1', 'Readable name']]),
    })
    expect(seam?.('doc-1')).toEqual({ markdown: BODY, label: 'Readable name' })
  })

  it('answers for a reference the content resolver does not know', () => {
    const seam = composeReferenceSeam({
      content: () => undefined,
      labels: new Map([['doc-1', 'Readable name']]),
    })
    expect(seam?.('doc-1')).toEqual({ label: 'Readable name' })
    expect(seam?.('doc-2')).toBeUndefined()
  })

  it('marks a dangling reference missing, and only that one', () => {
    const seam = composeReferenceSeam({
      content: () => ({ markdown: BODY }),
      missing: new Set(['gone']),
    })
    expect(seam?.('gone')).toEqual({ markdown: BODY, missing: true })
    expect(seam?.('here')).toEqual({ markdown: BODY })
  })

  it('carries content through unchanged when there is no chrome to layer', () => {
    const seam = composeReferenceSeam({
      content: (ref) => (ref === 'x' ? { markdown: BODY } : undefined),
    })
    expect(seam?.('x')).toEqual({ markdown: BODY })
    expect(seam?.('y')).toBeUndefined()
  })
})
