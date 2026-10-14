/**
 * What the layout asks a keeper to resolve as a stored picture is a subset of
 * what the file GC keeps. The two answers come from different packages (the
 * renderer asks per node as it draws, the GC reads the stored document), so
 * the oracle here is the layout's own recorded asks, not the walk the GC
 * shares with the loader.
 *
 * The asks are recorded through the `references` bundle, the form a
 * composition root passes: a bare `resolveReference` option reaches file
 * nodes and frame backgrounds only, so an inline `![](asset:…)` in a text
 * node would never be asked and that arm would check nothing.
 */
import {
  createSpatialTheme,
  layoutSpatialCanvas,
  referenceSeams,
} from '@kamiazya/whiteboard-canvas-render'
import { createFakeMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
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

/** Lays `c` out and answers every stored-picture ref it asked a keeper for. */
function drawnImageRefs(c: SpatialCanvas): string[] {
  const asked: string[] = []
  layoutSpatialCanvas(c, {
    measure: createFakeMeasure(0.6),
    parseBody: parseMarkdownBody,
    appearance: createSpatialTheme({ mode: 'light' }),
    references: referenceSeams(new Map(), {
      extra: (ref) => {
        if (isImageRef(ref)) asked.push(ref)
        return { image: { href: `blob:${ref}` } }
      },
    }),
  })
  return asked
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
