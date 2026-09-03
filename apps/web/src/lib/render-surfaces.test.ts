import { documentKindSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { RENDER_SURFACES, type RenderSurfaceId } from './render-surfaces.js'

const entries = Object.entries(RENDER_SURFACES) as [
  RenderSurfaceId,
  (typeof RENDER_SURFACES)[RenderSurfaceId],
][]

describe('the render surface registry', () => {
  // The type says every kind is answered; this says the answers are readable.
  // An exemption whose reason is empty is the omission with a word in front.
  it('gives every uncovered kind a reason someone can act on', () => {
    for (const [id, surface] of entries) {
      for (const [kind, coverage] of Object.entries(surface.kinds)) {
        if (coverage === 'covered') continue
        const reason = coverage.slice('not covered:'.length).trim()
        expect(reason.length, `${id}/${kind} needs a reason`).toBeGreaterThan(10)
      }
    }
  })

  it('gives every surface outside the broker a reason', () => {
    for (const [id, surface] of entries) {
      if (surface.broker === 'through') continue
      const reason = surface.broker.slice('not yet:'.length).trim()
      expect(reason.length, `${id} needs a reason`).toBeGreaterThan(10)
    }
  })

  // The registry's whole claim is that it names the kinds exhaustively. If
  // the model's union and this table's key set ever diverge, the type check
  // catches it — this pins that the type being relied on is the real one.
  it('answers exactly the document kinds the model declares', () => {
    const declared = new Set(documentKindSchema.options)
    for (const [id, surface] of entries) {
      expect(new Set(Object.keys(surface.kinds)), `${id}`).toEqual(declared)
    }
  })

  // The measured defect this table exists for: the SVG family serves both
  // kinds, and the surfaces that do not are each a stated decision.
  it('has every svg surface answering for markdown', () => {
    for (const [id, surface] of entries) {
      if (surface.pipeline !== 'svg') continue
      expect(surface.kinds.markdown, `${id}`).toBe('covered')
    }
  })
})
