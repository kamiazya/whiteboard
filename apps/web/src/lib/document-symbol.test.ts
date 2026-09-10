// @vitest-environment node
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { resolveOpenDocumentSymbol } from './document-symbol.js'

const PIN = { kind: 'emoji', char: '📌' } as const

function markedCanvas(): SpatialCanvas {
  return { nodes: [], edges: [], 'x-whiteboard': { facets: { 'visual.symbol/v0': PIN } } }
}

describe('resolveOpenDocumentSymbol', () => {
  it('reads a spatial document’s mark off the canvas envelope', () => {
    expect(resolveOpenDocumentSymbol({ kind: 'spatial', canvas: markedCanvas() })).toEqual(PIN)
  })

  // The half that was missing, and the reason it needed one place rather than
  // two: a markdown document keeps its mark where no canvas value can carry
  // it, so a page reading only the canvas draws nothing for it.
  it('reads a markdown document’s mark off its frontmatter facets', () => {
    expect(
      resolveOpenDocumentSymbol({ kind: 'markdown', facets: { 'visual.symbol/v0': PIN } }),
    ).toEqual(PIN)
  })

  // Each kind reads its OWN place, so a mark stored in the other one is not
  // there to be found — which is what stops one kind answering for the other.
  it('does not read a canvas envelope for a markdown document', () => {
    expect(resolveOpenDocumentSymbol({ kind: 'markdown', canvas: markedCanvas() })).toBeUndefined()
  })

  it('does not read frontmatter facets for a spatial document', () => {
    expect(
      resolveOpenDocumentSymbol({
        kind: 'spatial',
        canvas: { nodes: [], edges: [] },
        facets: { 'visual.symbol/v0': PIN },
      }),
    ).toBeUndefined()
  })

  it('answers nothing before the canvas has arrived', () => {
    expect(resolveOpenDocumentSymbol({ kind: 'spatial', canvas: null })).toBeUndefined()
    expect(resolveOpenDocumentSymbol({ kind: 'spatial' })).toBeUndefined()
  })

  it('answers nothing for a document that declares none', () => {
    expect(resolveOpenDocumentSymbol({ kind: 'markdown', facets: {} })).toBeUndefined()
    expect(resolveOpenDocumentSymbol({ kind: 'markdown' })).toBeUndefined()
  })

  // An unresolvable payload is no symbol, never a different fallback — the
  // rule the plugin's resolvers hold for every surface.
  it('answers nothing for a payload that does not resolve', () => {
    expect(
      resolveOpenDocumentSymbol({ kind: 'markdown', facets: { 'visual.symbol/v0': {} } }),
    ).toBeUndefined()
  })
})
