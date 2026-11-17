/**
 * What the layout draws as a stored picture is a subset of what the file GC
 * keeps. The two answers come from different places (the Rust core draws
 * each node, the GC reads the stored document), so the oracle here is what
 * the core actually DREW, not the walk the GC shares with the loader: every
 * `asset:` ref spelled anywhere in the canvas is offered a picture through
 * the reference wire, the form a composition root passes, and the drawn ones
 * are read back off the scene's image hrefs.
 */
import {
  createSpatialTheme,
  layoutSpatialCanvas,
  referenceSeamsFromWire,
  referenceWire,
} from '@kamiazya/whiteboard-canvas-render'
import { createFakeMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { testLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils/node-core'
import { collectImageRefIds, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import {
  imageRefId,
  isImageRef,
  newImageRef,
  type SpatialCanvas,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import { fileNode, groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'

const id = fc.stringMatching(/^[a-z0-9]{1,8}$/)

const node: fc.Arbitrary<(n: number) => SpatialNode> = fc.oneof(
  id.map(
    (ref) => (n: number) =>
      groupNode({
        id: `n${n}`,
        x: 0,
        y: n * 400,
        width: 300,
        height: 200,
        label: 'F',
        background: newImageRef(ref),
        backgroundStyle: 'cover',
      }),
  ),
  id.map(
    (ref) => (n: number) =>
      fileNode({ id: `n${n}`, x: 0, y: n * 400, width: 100, height: 100, file: newImageRef(ref) }),
  ),
  id.map(
    (ref) => (n: number) =>
      textNode({
        id: `n${n}`,
        x: 0,
        y: n * 400,
        width: 200,
        height: 100,
        text: `see ![pic](${newImageRef(ref)}) here`,
      }),
  ),
  // A titled image: the title follows the destination after a space, and a
  // walk that read it as part of the URL would keep an id no blob has while
  // the drawn picture's own blob looked unused.
  id.map(
    (ref) => (n: number) =>
      textNode({
        id: `n${n}`,
        x: 0,
        y: n * 400,
        width: 200,
        height: 100,
        text: `see ![pic](${newImageRef(ref)} "A title") here`,
      }),
  ),
  fc.constant((n: number) =>
    fileNode({ id: `n${n}`, x: 0, y: n * 400, width: 100, height: 100, file: 'boards/other' }),
  ),
)

/** Lays `c` out and answers every stored-picture ref the core drew, in the order drawn. */
function drawnImageRefs(c: SpatialCanvas): string[] {
  // Every ref the canvas spells, found by its text alone: offering a picture
  // for one the layout does not draw is harmless, and missing one would hide it.
  const spelled = [...new Set(JSON.stringify(c).match(/asset:[A-Za-z0-9_-]+/g) ?? [])]
  const extras = new Map(spelled.map((ref) => [ref, { image: { href: `blob:${ref}` } }] as const))
  const scene = layoutSpatialCanvas(c, {
    core: testLayoutCore(),
    measure: createFakeMeasure(0.6),
    appearance: createSpatialTheme({ mode: 'light' }),
    references: referenceSeamsFromWire(referenceWire(new Map(), { extras })),
  })
  // A file node or a frame background draws an image node (`href`); an inline
  // image paints its run (`src`).
  const drawn = JSON.stringify(scene).matchAll(/"(?:href|src)":"blob:(asset:[A-Za-z0-9_-]+)"/g)
  return [...new Set([...drawn].map((match) => match[1] as string))].filter(isImageRef)
}

const canvas: fc.Arbitrary<SpatialCanvas> = fc
  .array(node, { minLength: 1, maxLength: 6 })
  .map((builders) => ({ nodes: builders.map((build, n) => build(n)), edges: [] }))

describe('file GC keeps every picture the layout draws', () => {
  let drawnTotal = 0

  fcTest.prop([canvas], withDefaults())(
    'every asset ref the layout resolves is in the GC set',
    (c) => {
      const asked = drawnImageRefs(c)
      const doc = new LoroDoc()
      writeSpatialCanvas(doc, c)
      const kept = collectImageRefIds(doc)
      for (const ref of asked) expect(kept.has(imageRefId(ref))).toBe(true)
      drawnTotal += asked.length
    },
  )

  it('the generator reaches pictures at all', () => {
    expect(drawnTotal).toBeGreaterThan(20)
  })

  it('the oracle records an inline image, titled or not', () => {
    const text = 'see ![a](asset:plain) and ![b](asset:titled "A title") here'
    const c = {
      nodes: [textNode({ id: 'n0', x: 0, y: 0, width: 400, height: 100, text })],
      edges: [],
    }
    expect(drawnImageRefs(c)).toEqual(['asset:plain', 'asset:titled'])
  })
})
