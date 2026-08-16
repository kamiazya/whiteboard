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
/**
 * One entry per seam the predicate disqualifies on. Listed individually
 * rather than only as a combined object because a combined fixture cannot
 * fail for a seam the predicate FORGOT: with four other clauses already
 * returning false, deleting any one clause leaves every assertion green.
 * That is how `resolveFileMarkdown` was added to the predicate with no test
 * that could fail — caught in review, pinned here.
 */
const SEAMS: Record<string, unknown> = {
  resolveFileCanvas: () => undefined,
  resolveFileMarkdown: () => undefined,
  expandFileNode: () => false,
  resolveFileImage: () => undefined,
  resolveFileFacets: () => undefined,
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
