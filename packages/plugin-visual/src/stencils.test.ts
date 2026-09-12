// The bundled STENCIL set (ADR-0034) and the one function that applies one.
//
// Two things are worth testing here that a schema cannot say. The set has to
// be DISCRIMINABLE — ADR-0033's `distance` column is the fewest channels any
// two treatments in use differ on, so a set whose members collide on a
// channel ships a vocabulary that reads as one thing. And applying a stencil
// has to leave a RECORD, because that record is what makes the drawing's
// distinctions legible to the facet axis rather than merely visible.
import { createFacetRegistry, definePlugin } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import {
  applyStencil,
  bundledFacetRegistry,
  bundledPlugins,
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

  it('spends NO colour, so the channel is free for a second axis', () => {
    // ADR-0035 §5. A channel carries at most one semantic axis, and the kind
    // axis has one of its own now that the silhouette vocabulary holds six.
    // The user's case (2026-09-12) is the one this is for: an infrastructure
    // drawing says what each component IS with its shape and whether it is
    // healthy with its colour, and a vocabulary that writes a colour spends
    // the channel the second axis needs.
    for (const id of ids) expect(bundledFacetRegistry.stencilAsset(id)?.color).toBeUndefined()
  })

  it('gives no two members the same silhouette, which is the channel that survives greyscale', () => {
    // ADR-0033's `distance`, asserted on the SET rather than on a drawing:
    // two stencils a reader cannot tell apart are a defect in the vocabulary,
    // and no board using them can be scored out of it.
    //
    // ONE channel, where this used to demand two — and the reason it demanded
    // two is the reason one is now enough. Colour is the channel most often
    // lost (a projector, a colour-blind reader, a greyscale print), so a set
    // leaning on colour AND silhouette really leaned on silhouette for any
    // reader who lost it. Spending no colour at all does not weaken that; it
    // ends the pretence, and hands the lost-anyway channel to whatever axis
    // the drawing declares.
    //
    // The consequence for growth is unchanged in shape and changed in
    // number: every silhouette distinct means the set's ceiling is the
    // silhouette vocabulary, SIX today. A seventh stencil needs a seventh
    // silhouette, not a seventh entry.
    const silhouettes = ids.map((id) => ({
      id,
      shape: JSON.stringify(
        bundledFacetRegistry.stencilAsset(id)?.facets['visual.shape/v0'] ?? null,
      ),
    }))
    const collisions: string[] = []
    for (let i = 0; i < silhouettes.length; i++) {
      for (let j = i + 1; j < silhouettes.length; j++) {
        const a = silhouettes[i]
        const b = silhouettes[j]
        if (a === undefined || b === undefined) continue
        if (a.shape === b.shape) collisions.push(`${a.id} vs ${b.id}`)
      }
    }
    expect(collisions).toEqual([])
    // And none of them is the plain rect, which is what an UNDRESSED box
    // draws: a construct whose every member wears the default treatment is
    // ADR-0033's `deficit`, and before the octagon `service` was exactly
    // that the moment colour went away.
    expect(silhouettes.filter((s) => s.shape === 'null')).toEqual([])
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

  it('clears a previous stencil’s colour when the new one sets none', () => {
    // Found by re-reading the diff, not by a failing test: the facets of a
    // previous stencil were dropped and its COLOUR was not, so a re-dressed
    // box wore a mixture belonging to neither construct — ADR-0033's
    // `excess` shape. Unreachable on the bundled set (every member sets a
    // colour), so it is exercised through an extra plugin shipping stencils
    // BESIDE the bundled ones.
    //
    // Note what that registry has to include. The record always goes under
    // `visual.stencil/v0` whoever authored the stencil, so a registry
    // without the `visual` plugin cannot read one back at all — the first
    // version of this test built a registry from its own plugin alone, and
    // the clearing looked broken when the test was.
    const registry = createFacetRegistry([
      ...bundledPlugins,
      definePlugin({
        id: 'extra',
        displayName: 'Extra',
        facets: [],
        assets: {
          stencils: {
            loud: { displayName: 'Loud', color: '1' },
            quiet: { displayName: 'Quiet' },
          },
        },
      }),
    ])
    const loud = applyStencil(box(), 'extra.loud', registry) as Node
    expect(loud.color).toBe('1')
    const quiet = applyStencil(loud, 'extra.quiet', registry) as Node
    expect(quiet.color).toBeUndefined()
    expect(resolveNodeStencil(quiet, registry)).toBe('extra.quiet')
  })

  it('leaves a second axis’s colour alone through dressing AND re-dressing', () => {
    // The payoff of spending no colour, stated as behaviour rather than as
    // a score: the board below is coloured by health, and dressing a box by
    // KIND — then changing its kind — no longer destroys what the colour
    // said. Before this, `applyStencil` wrote the stencil's colour over it
    // and the status axis was silently undrawn.
    const failing = box({ color: '1' })
    const dressed = applyStencil(failing, 'visual.datastore') as Node
    expect(dressed.color).toBe('1')
    const redressed = applyStencil(dressed, 'visual.queue') as Node
    expect(redressed.color).toBe('1')
    // The kind axis still moved, on its own channel.
    expect(resolveNodeShape(redressed)).toBe('parallelogram')
  })

  it('leaves a colour the box had before any stencil alone', () => {
    // The other side of that rule: nothing here can tell a hand-picked
    // colour from a vocabulary's, so an undressed box keeps what it had.
    const registry = createFacetRegistry([
      ...bundledPlugins,
      definePlugin({
        id: 'extra2',
        displayName: 'Extra2',
        facets: [],
        assets: { stencils: { quiet: { displayName: 'Quiet' } } },
      }),
    ])
    expect((applyStencil(box({ color: '3' }), 'extra2.quiet', registry) as Node).color).toBe('3')
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
