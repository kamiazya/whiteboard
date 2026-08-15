import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { canLayoutInWorker } from './layout-worker-protocol.js'

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
const seams = {
  resolveFileCanvas: () => undefined,
  expandFileNode: () => false,
  resolveFileImage: () => undefined,
  resolveFileFacets: () => undefined,
}

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

  it('offloads a canvas with file nodes when no seam is supplied', () => {
    expect(canLayoutInWorker({}, withFile)).toBe(true)
  })
})
