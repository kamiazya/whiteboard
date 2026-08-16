// A file node whose reference resolves to a MARKDOWN document renders that
// document's body inline, the markdown sibling of the canvas-embed seam in
// spatial-embed.test.ts. Ranked between that seam and the facet card: a
// document's own prose says more than its facets, and less than a spatial
// canvas or an image the caller already resolved.
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import type { EmbedResolvedNode, ImageSceneNode, SceneNode, TextRunNode } from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { SPATIAL_THEME_GEOMETRY } from '../theme/spatial-geometry.js'
import {
  type FacetCardData,
  layoutSpatialCanvas,
  type ResolvedReference,
  type SpatialLayoutOptions,
} from './spatial-canvas.js'

const APPEARANCE = {
  resolveNode: () => ({}),
  resolveEdge: () => ({}),
  resolveLabel: () => ({}),
}

function baseOptions(over?: Partial<SpatialLayoutOptions>): SpatialLayoutOptions {
  return {
    measure: createFakeMeasure(),
    parseBody: () => ({ type: 'root', children: [] }),
    appearance: APPEARANCE,
    ...over,
  }
}

const NODE = {
  id: 'f1',
  type: 'file',
  x: 100,
  y: 100,
  width: 300,
  height: 200,
  file: 'notes',
} satisfies SpatialNode

const canvasOf = (over?: Partial<Extract<SpatialNode, { type: 'file' }>>): SpatialCanvas => ({
  nodes: [{ ...NODE, ...over }],
  edges: [],
})

const paragraph = (value: string): MdastRoot['children'][number] => ({
  type: 'paragraph',
  children: [{ type: 'text', value }],
})

const BODY: MdastRoot = {
  type: 'root',
  children: [
    { type: 'heading', depth: 1, children: [{ type: 'text', value: 'Release notes' }] },
    paragraph('Shipped the markdown file node.'),
  ],
}

const CARD: FacetCardData = { title: 'Card', rows: [{ label: 'type', value: 'note' }] }

/**
 * Every text run reachable anywhere in the scene, flattened. Block nodes
 * carry their runs under `runs` and their nested blocks under `children`,
 * so both have to be walked.
 */
function runsOf(nodes: readonly SceneNode[]): TextRunNode[] {
  const out: TextRunNode[] = []
  const visit = (node: SceneNode) => {
    if (node.kind === 'textRun') out.push(node)
    const branch = node as { runs?: readonly TextRunNode[]; children?: readonly SceneNode[] }
    for (const run of branch.runs ?? []) visit(run)
    for (const child of branch.children ?? []) visit(child)
  }
  for (const node of nodes) visit(node)
  return out
}

const textOf = (nodes: readonly SceneNode[]) => runsOf(nodes).map((run) => run.text)

/**
 * All run text as one string. `layoutMdastBlocks` places body phrasing one
 * run per WORD (each at its own measured x), so a sentence never survives
 * as a single run — asserting on one would be asserting against the
 * layout's own wrapping model rather than against content.
 */
const proseOf = (nodes: readonly SceneNode[]) => textOf(nodes).join(' ')

describe('file-node markdown bodies', () => {
  it('lays the referenced body out inside the node content area', () => {
    const scene = layoutSpatialCanvas(
      canvasOf(),
      baseOptions({
        resolveReference: (ref) => (ref === 'notes' ? { markdown: BODY } : undefined),
      }),
    )

    expect(textOf(scene.nodes)).toContain('Release notes')
    expect(proseOf(scene.nodes)).toContain('Shipped the markdown file node.')

    const padding = SPATIAL_THEME_GEOMETRY.paddingPx
    const heading = scene.nodes.find((node) => node.kind === 'heading')
    expect(heading).toBeDefined()
    if (heading === undefined) throw new Error('unreachable')
    expect(heading.bbox.x).toBeGreaterThanOrEqual(NODE.x + padding)
    expect(heading.bbox.y).toBeGreaterThanOrEqual(NODE.y + padding)
  })

  it('places the reference label above the frame, as the canvas-embed seam does', () => {
    const scene = layoutSpatialCanvas(
      canvasOf(),
      baseOptions({
        resolveReference: () => ({ markdown: BODY, label: 'Release notes doc' }),
      }),
    )
    const label = runsOf(scene.nodes).find((run) => run.text === 'Release notes doc')
    expect(label).toBeDefined()
    // Above the frame's top edge — the container convention, so the body
    // gets the whole padded box.
    expect(label?.bbox.y).toBeLessThan(NODE.y)
  })

  it('never paints a block below the node padded content box', () => {
    const long: MdastRoot = {
      type: 'root',
      children: Array.from({ length: 40 }, (_, i) => paragraph(`line ${i}`)),
    }
    const scene = layoutSpatialCanvas(
      canvasOf(),
      baseOptions({ resolveReference: () => ({ markdown: long }) }),
    )
    const bottom = NODE.y + NODE.height - SPATIAL_THEME_GEOMETRY.paddingPx
    const blocks = scene.nodes.filter((node) => node.kind === 'paragraph')
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.length).toBeLessThan(long.children.length)
    for (const block of blocks) {
      expect(block.bbox.y + block.bbox.h).toBeLessThanOrEqual(bottom)
    }
  })

  describe('seam precedence', () => {
    it('a resolved image outranks a resolved markdown body', () => {
      const scene = layoutSpatialCanvas(
        canvasOf(),
        baseOptions({
          resolveReference: () => ({
            image: { href: 'data:image/png;base64,AAAA' },
            markdown: BODY,
          }),
        }),
      )
      expect(scene.nodes.some((node): node is ImageSceneNode => node.kind === 'image')).toBe(true)
      expect(textOf(scene.nodes)).not.toContain('Release notes')
    })

    it('a resolved canvas embed outranks a resolved markdown body', () => {
      const child: SpatialCanvas = {
        nodes: [{ id: 'c1', type: 'text', x: 0, y: 0, width: 400, height: 200, text: '' }],
        edges: [],
      }
      const scene = layoutSpatialCanvas(
        canvasOf(),
        baseOptions({
          resolveReference: () => ({ canvas: child, markdown: BODY }),
          expandFileNode: () => true,
        }),
      )
      expect(
        scene.nodes.some((node): node is EmbedResolvedNode => node.kind === 'embedResolved'),
      ).toBe(true)
      expect(textOf(scene.nodes)).not.toContain('Release notes')
    })

    it('a resolved markdown body outranks a resolved facet card', () => {
      const scene = layoutSpatialCanvas(
        canvasOf(),
        baseOptions({
          resolveReference: () => ({ markdown: BODY, facets: CARD }),
        }),
      )
      expect(textOf(scene.nodes)).toContain('Release notes')
      expect(textOf(scene.nodes)).not.toContain('Card')
    })
  })

  describe('totality', () => {
    const fallsBack: Array<[string, ResolvedReference]> = [
      ['a resolution carrying no body', { facets: CARD }],
      ['an empty body', { markdown: { type: 'root', children: [] }, facets: CARD }],
    ]

    for (const [name, resolution] of fallsBack) {
      it(`falls through to the facet card for ${name}`, () => {
        const scene = layoutSpatialCanvas(
          canvasOf(),
          baseOptions({ resolveReference: () => resolution }),
        )
        expect(textOf(scene.nodes)).toContain('Card')
      })
    }

    it('falls all the way to the plain label when the resolver throws', () => {
      // Not to the card, unlike the cases above. One resolver answers for
      // every content kind, so a throw loses the whole resolution rather
      // than one rank of it — the price of collapsing six seams into one,
      // and the reason the caller's lookup, not the layout, is where a
      // partial failure has to be handled.
      const scene = layoutSpatialCanvas(
        canvasOf(),
        baseOptions({
          resolveReference: () => {
            throw new Error('boom')
          },
        }),
      )
      expect(textOf(scene.nodes)).toEqual(['notes'])
    })

    it('falls through to the plain label when nothing else resolves', () => {
      const scene = layoutSpatialCanvas(
        canvasOf(),
        baseOptions({ resolveReference: () => undefined }),
      )
      expect(textOf(scene.nodes)).toEqual(['notes'])
    })

    it('keeps the card when the node is too small for even one block', () => {
      const scene = layoutSpatialCanvas(
        canvasOf({ width: 4, height: 4 }),
        baseOptions({ resolveReference: () => ({ markdown: BODY, facets: CARD }) }),
      )
      expect(textOf(scene.nodes)).not.toContain('Release notes')
    })

    it('renders the plain label when no resolver is supplied at all', () => {
      const scene = layoutSpatialCanvas(canvasOf(), baseOptions())
      expect(textOf(scene.nodes)).toEqual(['notes'])
    })
  })
})

describe('malformed bodies never abort the canvas', () => {
  // A resolver is caller-supplied, so its RETURN VALUE is caller-supplied
  // too. Every body below is `{type:'root', children:[...]}` — root-shaped,
  // so a shape-only check at the caller's boundary lets it through — with a
  // child `layoutBlock`'s switch cannot handle. Each one threw out of
  // `layoutSpatialCanvas` before the layout call was guarded, taking the
  // whole canvas with it, including nodes that have nothing to do with the
  // reference.
  const malformed: Array<[string, unknown]> = [
    ['a null child', null],
    ['a primitive child', 'hi'],
    ['an unrecognised type', { type: 'bogus' }],
    ['a heading with no children', { type: 'heading', depth: 1 }],
    ['a code node with no value', { type: 'code' }],
  ]

  const withSibling = (over?: Partial<Extract<SpatialNode, { type: 'file' }>>): SpatialCanvas => ({
    nodes: [
      { ...NODE, ...over },
      { id: 'sibling', type: 'text', x: 500, y: 0, width: 200, height: 100, text: 'SIBLING' },
    ],
    edges: [],
  })

  for (const [name, child] of malformed) {
    it(`degrades to the card for ${name}, and still renders the rest of the canvas`, () => {
      const body = { type: 'root', children: [child] } as unknown as MdastRoot
      let scene!: ReturnType<typeof layoutSpatialCanvas>
      expect(() => {
        scene = layoutSpatialCanvas(
          withSibling(),
          baseOptions({
            parseBody: () => ({
              type: 'root',
              children: [{ type: 'paragraph', children: [{ type: 'text', value: 'SIBLING' }] }],
            }),
            resolveReference: () => ({ markdown: body, facets: CARD }),
          }),
        )
      }).not.toThrow()

      // The unrelated node still rendered — the point of the guard.
      expect(proseOf(scene.nodes)).toContain('SIBLING')
      // And the file node fell through to the next-ranked seam.
      expect(textOf(scene.nodes)).toContain('Card')
    })
  }

  it('reports the degradation rather than swallowing it', () => {
    const events: string[] = []
    layoutSpatialCanvas(
      canvasOf(),
      baseOptions({
        resolveReference: () => ({
          markdown: { type: 'root', children: [null] } as unknown as MdastRoot,
        }),
        onDegrade: (event) => events.push(event.kind),
      }),
    )
    expect(events).toContain('body-parse-failed')
  })
})
