// The bundled STENCIL set (ADR-0034) and the one function that applies one.
//
// Two things are worth testing here that a schema cannot say. The set has to
// be DISCRIMINABLE — ADR-0033's `distance` column is the fewest channels any
// two treatments in use differ on, so a set whose members collide on a
// channel ships a vocabulary that reads as one thing. And applying a stencil
// has to leave a RECORD, because that record is what makes the drawing's
// distinctions legible to the facet axis rather than merely visible.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import {
  applyStencil,
  bundledFacetRegistry,
  resolveNodeShape,
  resolveNodeStencil,
  resolveNodeSymbol,
  VISUAL_SHAPE_KEY,
  VISUAL_STENCIL_KEY,
  VISUAL_STENCILS,
  VISUAL_SYMBOL_KEY,
} from './index.js'

type Node = SpatialCanvas['nodes'][number]
const box = (extra: Partial<Node> = {}): Node =>
  ({ id: 'n1', type: 'text', x: 0, y: 0, width: 200, height: 80, text: 'n1', ...extra }) as Node

const ids = Object.keys(VISUAL_STENCILS).map((name) => `visual.${name}`)

describe('the bundled stencil set', () => {
  it('registers every member through the ordinary asset path', () => {
    for (const id of ids) expect(bundledFacetRegistry.stencilAsset(id)?.displayName).toBeTruthy()
    expect(bundledFacetRegistry.assetIds('stencils')).toEqual(ids)
  })

  it('gives no two members the same appearance, on at least two channels', () => {
    // ADR-0033's `distance`, asserted on the SET rather than on a drawing:
    // two stencils a reader cannot tell apart are a defect in the vocabulary,
    // and no board using them can be scored out of it. Two channels rather
    // than one because colour alone is the channel most often lost — a
    // projector, a colour-blind reader, a greyscale print.
    const treatments = ids.map((id) => {
      const stencil = bundledFacetRegistry.stencilAsset(id)
      return {
        id,
        colour: stencil?.color ?? '',
        shape: JSON.stringify(stencil?.facets['visual.shape/v0'] ?? null),
        badge: JSON.stringify(stencil?.facets['visual.symbol/v0'] ?? null),
      }
    })
    const tooClose: string[] = []
    for (let i = 0; i < treatments.length; i++) {
      for (let j = i + 1; j < treatments.length; j++) {
        const a = treatments[i]
        const b = treatments[j]
        if (a === undefined || b === undefined) continue
        const apart =
          (a.colour === b.colour ? 0 : 1) +
          (a.shape === b.shape ? 0 : 1) +
          (a.badge === b.badge ? 0 : 1)
        if (apart < 2) tooClose.push(`${a.id} vs ${b.id}: ${apart}`)
      }
    }
    expect(tooClose).toEqual([])
  })

  it('sets no geometry and no text, which is what keeps it a vocabulary', () => {
    // ADR-0034 decision 3. A stencil that carried a position would be a
    // second producer of geometry; one that carried text would be drawing
    // the diagram rather than supplying the words for it.
    for (const id of ids) {
      const stencil = bundledFacetRegistry.stencilAsset(id)
      expect(Object.keys(stencil ?? {}).sort()).toEqual(
        Object.keys(stencil ?? {})
          .filter((k) => !['x', 'y', 'width', 'height', 'text'].includes(k))
          .sort(),
      )
      expect(stencil?.facets['visual.text/v0']).toBeUndefined()
    }
  })

  it('writes the same facet keys data.ts exports, which the split made possible to get wrong', () => {
    // `stencils.ts` spells these as literals because importing them back
    // from `data.ts` — which imports the SET — would be a value cycle. That
    // duplication is only safe while something reads both sides.
    const keys = new Set(Object.values(VISUAL_STENCILS).flatMap((s) => Object.keys(s.facets ?? {})))
    expect([...keys].sort()).toEqual([VISUAL_SHAPE_KEY, VISUAL_SYMBOL_KEY].sort())
  })
})

describe('applying a stencil', () => {
  it('expands into the node AND records which stencil it came from', () => {
    const applied = applyStencil(box(), 'visual.datastore')
    // Expanded: every existing reader draws it with no knowledge of stencils.
    expect(applied?.color).toBe(bundledFacetRegistry.stencilAsset('visual.datastore')?.color)
    expect(resolveNodeShape(applied as Node)).toBe('cylinder')
    // Recorded: the id is a partition the DOCUMENT declares, which is what
    // lets the facet axis read the drawing as carrying its own distinctions.
    expect(resolveNodeStencil(applied as Node)).toBe('visual.datastore')
  })

  it('answers undefined for a stencil nobody registered, rather than a half-applied node', () => {
    expect(applyStencil(box(), 'visual.nope')).toBeUndefined()
    expect(applyStencil(box(), 'not-an-id')).toBeUndefined()
  })

  it('leaves the node it was given untouched', () => {
    const before = box()
    const snapshot = JSON.stringify(before)
    applyStencil(before, 'visual.datastore')
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('keeps position, size and text — a stencil says what a box IS, not where or what it says', () => {
    const applied = applyStencil(
      box({ x: 40, y: 90, width: 300, height: 120, text: 'orders' }),
      'visual.datastore',
    )
    expect([applied?.x, applied?.y, applied?.width, applied?.height]).toEqual([40, 90, 300, 120])
    expect((applied as { text?: string } | undefined)?.text).toBe('orders')
  })

  it('replaces a previous stencil rather than layering two vocabularies on one box', () => {
    const once = applyStencil(box(), 'visual.datastore') as Node
    const twice = applyStencil(once, 'visual.queue') as Node
    expect(resolveNodeStencil(twice)).toBe('visual.queue')
    // The cylinder must be GONE: a box wearing one stencil's silhouette and
    // another's colour belongs to neither construct, which ADR-0033 scores
    // as `excess` — a distinction the reader looks for and does not find.
    expect(resolveNodeShape(twice)).toBe(
      (
        bundledFacetRegistry.stencilAsset('visual.queue')?.facets['visual.shape/v0'] as
          | { kind?: string }
          | undefined
      )?.kind,
    )
    expect(resolveNodeSymbol(twice)).toEqual(
      bundledFacetRegistry.stencilAsset('visual.queue')?.facets['visual.symbol/v0'],
    )
  })

  it('refuses to write a stencil the registry would refuse, so the record cannot go stale at birth', () => {
    expect(
      bundledFacetRegistry.validateFacetWrite(VISUAL_STENCIL_KEY, { stencil: 'visual.nope' }).ok,
    ).toBe(false)
    expect(
      bundledFacetRegistry.validateFacetWrite(VISUAL_STENCIL_KEY, { stencil: 'visual.datastore' })
        .ok,
    ).toBe(true)
  })
})
