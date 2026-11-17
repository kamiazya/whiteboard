import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { fileNode, groupNode, linkNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { SceneNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { referenceSeamsFromWire, referenceWire } from '../references/wire.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { built } from '../test-utils/wasm/glue.js'
import { oracleLayoutCore } from '../test-utils/wasm/oracle-layout-core.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import type { SpatialLayoutOptions } from './layout-options.js'
import { layoutSpatialCanvas, naturalNodeContentSize } from './spatial-canvas.js'

/**
 * The fit and containment laws over generated boards, stated against what the
 * core lays out (ADR-0054 step 7): they were canvas-render's properties of
 * the TypeScript layout, and survive its deletion because each is about the
 * OUTPUT — where a node's ink lands against its own box — not about how the
 * layout got there. Example tests pin one fixture each; these say what holds
 * for ANY body in ANY box, which is the difference that matters: the first
 * shape of the fit passed three examples while breaking two cases nobody had
 * written an example for.
 *
 * The generators are main's. What changed is the options: the core parses a
 * body itself, takes a theme rather than a resolver, and reads a reference
 * off the wire, so the paragraph splitter, the stub appearance and the
 * resolving function became the codec's parser, the bundled light theme and
 * a one-entry wire.
 *
 * `fullWidth` charges every character a full em (not the uniform 0.6em the
 * default fake measurer charges) so a wrap is reachable at these widths.
 */
const fullWidth = createFakeMeasure(1)
const appearance = createSpatialTheme({ mode: 'light' })
const PADDING_PX = 8

const fitOptions = (): Pick<SpatialLayoutOptions, 'measure' | 'appearance' | 'core'> => ({
  measure: fullWidth,
  appearance,
  core: oracleLayoutCore(),
})

/** The laid-out blocks, i.e. everything the node paints that is not chrome. */
function blocksOf(canvas: SpatialCanvas): ReadonlyArray<{ y: number; h: number }> {
  return layoutSpatialCanvas(canvas, fitOptions())
    .nodes.filter((entry) => entry.kind !== 'shape' && entry.kind !== 'edge')
    .map((entry) => ({ y: entry.bbox.y, h: entry.bbox.h }))
}

function textNodeAt(width: number, height: number, text: string): SpatialCanvas {
  return { nodes: [textNode({ id: 'n', x: 0, y: 0, width, height, text })], edges: [] }
}

/** Bodies that wrap and bodies that do not, in one to five blocks. */
const bodyArb = fc
  .array(fc.constantFrom('かあらた', 'かたそ', 'short', 'a longer english line'), {
    minLength: 1,
    maxLength: 5,
  })
  .map((paras) => paras.join('\n\n'))

const widthArb = fc.integer({ min: 24, max: 200 })

/**
 * A fraction OF THE NATURAL CONTENT HEIGHT, never an absolute pixel range: a
 * uniform height would almost always be roomy enough to fit everything and
 * the properties would pass vacuously. Straddling 0..1.2 puts the generator
 * on both sides of every block boundary, which is where the rule lives.
 */
const fractionArb = fc.integer({ min: 0, max: 120 }).map((n) => n / 100)

/** What the body needs, measured the way the editor's grow probe measures. */
function naturalHeight(width: number, text: string): number {
  const node = textNodeAt(width, 1, text).nodes[0] as SpatialNode
  return Math.ceil(naturalNodeContentSize(node, fitOptions()).h + 2 * PADDING_PX)
}

describe.runIf(built)('a text node fits its body to its own box, through the core (PBT)', () => {
  fcTest.prop([widthArb, bodyArb, fractionArb], withDefaults())(
    'at most one block may cross the content box, and only when none fit',
    (width, text, fraction) => {
      const height = Math.round(naturalHeight(width, text) * fraction)
      const contentBottom = height - PADDING_PX
      fc.pre(height - 2 * PADDING_PX > 0)

      const crossing = blocksOf(textNodeAt(width, height, text)).filter(
        (block) => block.y + block.h > contentBottom,
      )

      // Zero when something fits; exactly one — the first block, kept so the
      // node never renders as an empty box — when nothing does.
      expect(crossing.length).toBeLessThanOrEqual(1)
    },
  )

  fcTest.prop([widthArb, bodyArb, fractionArb], withDefaults())(
    'never renders a non-empty body as an empty box',
    (width, text, fraction) => {
      const height = Math.round(naturalHeight(width, text) * fraction)
      fc.pre(height - 2 * PADDING_PX > 0)

      expect(blocksOf(textNodeAt(width, height, text)).length).toBeGreaterThan(0)
    },
  )

  fcTest.prop([widthArb, bodyArb, fractionArb], withDefaults())(
    'the natural content size is independent of the box it is stored in',
    (width, text, fraction) => {
      // What an auto-fit needs to know cannot be a function of the box it is
      // trying to resize, or the box can never grow past what it already is.
      const height = Math.max(1, Math.round(naturalHeight(width, text) * fraction))
      const node = (h: number) => textNodeAt(width, h, text).nodes[0] as SpatialNode

      expect(naturalNodeContentSize(node(height), fitOptions())).toEqual(
        naturalNodeContentSize(node(100_000), fitOptions()),
      )
    },
  )
})

/**
 * The containment law, stated once for EVERY node kind rather than per seam.
 *
 * Several seams put content in a node's box — a text body, a referenced
 * markdown body, a label — and each one that grew its own bound is a place
 * the next overflow can appear. So the guarantee is written against the
 * OUTPUT: whatever a node paints, wherever it came from, obeys the same rule.
 *
 * Two escapes, and they are enumerated rather than discovered:
 *
 * 1. A label placed ABOVE the frame. JSON Canvas puts a container's name
 *    outside its box, and an element wholly above `node.y` is that label and
 *    nothing else.
 * 2. The single piece of content kept when NOTHING fits, so a node one line
 *    tall renders its line instead of an empty box.
 *
 * Only the vertical axis: horizontal overflow has its own declared
 * exemptions (inline math is neither split nor cut, an atomic run is not
 * split) and its own instrument in `text-wrapping-quality.rust.test.ts`.
 */
const containmentShapeArb = fc.tuple(
  fc.integer({ min: 8, max: 240 }),
  fc.constantFrom(
    'かあらた\n\nかたそ',
    'a longer english line that wraps\n\nand a second block\n\nand a third',
    'short',
    '',
    '__THROW__',
  ),
  fc.constantFrom('text' as const, 'file' as const, 'link' as const, 'group' as const),
  fractionArb,
)

function containmentNode(
  width: number,
  text: string,
  type: 'text' | 'file' | 'link' | 'group',
  height: number,
): SpatialNode {
  const base = { id: 'n', x: 0, y: 0, width, height }
  if (type === 'text') return textNode({ ...base, text })
  if (type === 'file') return fileNode({ ...base, file: 'md.md' })
  if (type === 'link') return linkNode({ ...base, url: 'https://example.com' })
  return groupNode({ ...base, label: text })
}

/**
 * The reference RESOLVES to a body, so a file node takes the markdown seam
 * rather than falling straight to its label. A label-only reference leaves
 * that seam — one of the seams that put content in a box — untouched by every
 * property below, which is how a natural-size defect on small file nodes
 * survived its first review.
 */
const containmentWire = referenceWire(
  new Map([['md.md', { name: 'A referenced document', body: 'かあらた\n\nかたそ' }]]),
)

const containmentOptions = (): SpatialLayoutOptions => ({
  ...fitOptions(),
  references: referenceSeamsFromWire(containmentWire),
})

/** How far below the node's top its laid-out content reaches, outside label excluded. */
function contentBottomOf(node: SpatialNode): number {
  const scene = layoutSpatialCanvas({ nodes: [node], edges: [] }, containmentOptions())
  let bottom = PADDING_PX
  for (const entry of scene.nodes) {
    if (entry.kind === 'shape' || entry.kind === 'edge' || entry.bbox.y < node.y) continue
    bottom = Math.max(bottom, entry.bbox.y + entry.bbox.h - node.y)
  }
  return bottom
}

describe.runIf(built)(
  'every node kind keeps its ink inside its own frame, through the core (PBT)',
  () => {
    /**
     * Height is drawn as a FRACTION OF THE NATURAL CONTENT HEIGHT, per kind
     * and per body — never from a flat pixel range. Measured on the TypeScript
     * layout: a flat 1..160 range put roughly 1 run in 140 on a case where two
     * blocks cross the frame, so a mutation that deleted the fit passed on some
     * seeds and failed on others. Density is the fix, not more runs.
     *
     * The natural height is read off the roomy node's own LAYOUT — how far
     * down its content reaches — rather than asked of the size query, which
     * carries no reference wire: asked, a file node would answer its label's
     * height and the generator would never draw a box its body fits in.
     */
    function nodeFor(
      width: number,
      text: string,
      type: 'text' | 'file' | 'link' | 'group',
      fraction: number,
    ): SpatialNode {
      const roomy = containmentNode(width, text, type, 100_000)
      const natural = contentBottomOf(roomy) + PADDING_PX
      return containmentNode(width, text, type, Math.max(1, Math.round(natural * fraction)))
    }

    it('lays a file node out with the body its reference resolves to', () => {
      // Without this the file-node half of every law below could be judging
      // a label alone, which is how the natural-size defect first survived.
      const scene = layoutSpatialCanvas(
        { nodes: [containmentNode(200, '', 'file', 100_000)], edges: [] },
        containmentOptions(),
      )
      expect(JSON.stringify(scene.nodes)).toContain('かあらた')
    })

    fcTest.prop([containmentShapeArb], withDefaults())(
      'at most one element crosses the frame bottom, once the outside label is set aside',
      ([width, text, type, fraction]) => {
        const node = nodeFor(width, text, type, fraction)
        const scene = layoutSpatialCanvas({ nodes: [node], edges: [] }, containmentOptions())
        const inFrame = scene.nodes.filter(
          (entry): entry is Exclude<SceneNode, { kind: 'edge' }> =>
            entry.kind !== 'shape' && entry.kind !== 'edge' && entry.bbox.y >= node.y,
        )
        const crossing = inFrame.filter(
          (entry) => entry.bbox.y + entry.bbox.h > node.y + node.height,
        )

        expect(crossing.length).toBeLessThanOrEqual(1)
      },
    )

    fcTest.prop([containmentShapeArb], withDefaults())(
      'nothing is painted above the frame except one container label, and only where a container can have one',
      ([width, text, type, fraction]) => {
        const node = nodeFor(width, text, type, fraction)
        const scene = layoutSpatialCanvas({ nodes: [node], edges: [] }, containmentOptions())
        const above = scene.nodes.filter(
          (entry): entry is Exclude<SceneNode, { kind: 'edge' }> =>
            entry.kind !== 'shape' && entry.kind !== 'edge' && entry.bbox.y < node.y,
        )

        // A COUNT alone would accept a brand-new above-frame producer on a
        // text or link node, which has no outside label at all. The outside
        // label serves the two container-shaped kinds and is exactly one run.
        if (type === 'text' || type === 'link') {
          expect(above).toEqual([])
          return
        }
        expect(above.length).toBeLessThanOrEqual(1)
        for (const entry of above) expect(entry.kind).toBe('textRun')
      },
    )

    fcTest.prop([containmentShapeArb], withDefaults())(
      'the natural content size is independent of the box, for every node kind',
      ([width, text, type, fraction]) => {
        // The text-only version of this property missed a real defect: a file
        // node in a box smaller than its padding fell back to its label, so
        // the natural size reported the label for a small box and the body for
        // a large one. The core's size query carries no reference wire (it
        // refuses `references` as `CoreUnaskable`), so a file node is sized
        // by its label here; the body half of that defect is held where a
        // layout carries the wire, by the two containment laws above.
        const node = nodeFor(width, text, type, fraction)
        const roomy = containmentNode(width, text, type, 100_000)

        expect(naturalNodeContentSize(node, fitOptions())).toEqual(
          naturalNodeContentSize(roomy, fitOptions()),
        )
      },
    )
  },
)
