// A file node whose reference resolves to a MARKDOWN document renders that
// document's body inline, the markdown sibling of the canvas-embed seam in
// spatial-embed.test.ts. Ranked between that seam and the facet card: a
// document's own prose says more than its facets, and less than a spatial
// canvas or an image the caller already resolved.
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/mdast'
import { describe, expect, it } from 'vitest'
import type { EmbedResolvedNode, ImageSceneNode, SceneNode, TextRunNode } from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { SPATIAL_THEME_GEOMETRY } from '../theme/spatial-geometry.js'
import {
  type FacetCardData,
  layoutSpatialCanvas,
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
        resolveFileMarkdown: (file) => (file === 'notes' ? BODY : undefined),
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
        resolveFileMarkdown: () => BODY,
        resolveFileLabel: () => 'Release notes doc',
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
    const scene = layoutSpatialCanvas(canvasOf(), baseOptions({ resolveFileMarkdown: () => long }))
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
          resolveFileImage: () => ({ href: 'data:image/png;base64,AAAA' }),
          resolveFileMarkdown: () => BODY,
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
          resolveFileCanvas: () => child,
          expandFileNode: () => true,
          resolveFileMarkdown: () => BODY,
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
          resolveFileMarkdown: () => BODY,
          resolveFileFacets: () => CARD,
        }),
      )
      expect(textOf(scene.nodes)).toContain('Release notes')
      expect(textOf(scene.nodes)).not.toContain('Card')
    })
  })

  describe('totality', () => {
    const fallsBack: Array<[string, () => MdastRoot | undefined]> = [
      ['an undefined result', () => undefined],
      [
        'a throwing resolver',
        () => {
          throw new Error('boom')
        },
      ],
      ['an empty body', () => ({ type: 'root', children: [] })],
    ]

    for (const [name, resolveFileMarkdown] of fallsBack) {
      it(`falls through to the facet card for ${name}`, () => {
        const scene = layoutSpatialCanvas(
          canvasOf(),
          baseOptions({ resolveFileMarkdown, resolveFileFacets: () => CARD }),
        )
        expect(textOf(scene.nodes)).toContain('Card')
      })
    }

    it('falls through to the plain label when nothing else resolves', () => {
      const scene = layoutSpatialCanvas(
        canvasOf(),
        baseOptions({ resolveFileMarkdown: () => undefined }),
      )
      expect(textOf(scene.nodes)).toEqual(['notes'])
    })

    it('keeps the card when the node is too small for even one block', () => {
      const scene = layoutSpatialCanvas(
        canvasOf({ width: 4, height: 4 }),
        baseOptions({ resolveFileMarkdown: () => BODY, resolveFileFacets: () => CARD }),
      )
      expect(textOf(scene.nodes)).not.toContain('Release notes')
    })

    it('renders the plain label when no resolver is supplied at all', () => {
      const scene = layoutSpatialCanvas(canvasOf(), baseOptions())
      expect(textOf(scene.nodes)).toEqual(['notes'])
    })
  })
})
