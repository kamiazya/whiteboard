// The mdast content seams (`renderMath` / `renderDiagram` / `resolveEmbed`)
// reach a SPATIAL canvas's body layout, not just the markdown preview's.
//
// They were declared on `MdastLayoutOptions` and wired only by
// apps/web's preview pane, so the same document rendered its math and
// mermaid fences in the markdown editor and rendered them as placeholders
// the moment it was laid out inside a canvas node — one engine, two
// answers, depending on which surface called it.
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/mdast'
import { describe, expect, it } from 'vitest'
import type { SceneNode, SvgFragmentNode } from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutSpatialCanvas, type SpatialLayoutOptions } from './spatial-canvas.js'

const APPEARANCE = {
  resolveNode: () => ({}),
  resolveEdge: () => ({}),
  resolveLabel: () => ({}),
}

const BODY: MdastRoot = {
  type: 'root',
  children: [
    { type: 'math', value: 'E = mc^2' },
    { type: 'code', lang: 'mermaid', value: 'graph TD; a-->b;' },
    { type: 'paragraph', children: [{ type: 'embed', documentId: 'other' }] },
  ],
}

function baseOptions(over?: Partial<SpatialLayoutOptions>): SpatialLayoutOptions {
  return {
    measure: createFakeMeasure(),
    parseBody: () => BODY,
    appearance: APPEARANCE,
    ...over,
  }
}

/** A big node, so nothing is dropped by the content-box truncation. */
const textCanvas: SpatialCanvas = {
  nodes: [{ id: 't1', type: 'text', x: 0, y: 0, width: 600, height: 600, text: 'source' }],
  edges: [],
}

const fileCanvas: SpatialCanvas = {
  nodes: [
    {
      id: 'f1',
      type: 'file',
      x: 0,
      y: 0,
      width: 600,
      height: 600,
      file: 'notes',
    } satisfies SpatialNode,
  ],
  edges: [],
}

function fragmentsOf(nodes: readonly SceneNode[]): SvgFragmentNode[] {
  const out: SvgFragmentNode[] = []
  const visit = (node: SceneNode) => {
    if (node.kind === 'svgFragment') out.push(node)
    const branch = node as { runs?: readonly SceneNode[]; children?: readonly SceneNode[] }
    for (const run of branch.runs ?? []) visit(run)
    for (const child of branch.children ?? []) visit(child)
  }
  for (const node of nodes) visit(node)
  return out
}

const svgOf = (nodes: readonly SceneNode[]) => fragmentsOf(nodes).map((node) => node.svg)

const SEAMS = {
  renderMath: (value: string) => `<g data-math="${value}"/>`,
  renderDiagram: (lang: string, value: string) => `<g data-${lang}="${value.length}"/>`,
  resolveEmbed: (documentId: string) =>
    documentId === 'other'
      ? {
          title: 'Other',
          root: {
            type: 'root' as const,
            children: [
              {
                type: 'paragraph' as const,
                children: [{ type: 'text' as const, value: 'EMBEDDED' }],
              },
            ],
          },
        }
      : undefined,
}

/** Every run's text anywhere in the scene. */
function textOf(nodes: readonly SceneNode[]): string[] {
  const out: string[] = []
  const visit = (node: SceneNode) => {
    const entry = node as {
      kind: string
      text?: string
      runs?: readonly SceneNode[]
      children?: readonly SceneNode[]
    }
    if (entry.kind === 'textRun' && entry.text !== undefined) out.push(entry.text)
    for (const run of entry.runs ?? []) visit(run)
    for (const child of entry.children ?? []) visit(child)
  }
  for (const node of nodes) visit(node)
  return out
}

describe.each([
  ['a text node body', textCanvas, {} as Partial<SpatialLayoutOptions>],
  ['a markdown file node body', fileCanvas, { resolveReference: () => ({ markdown: BODY }) }],
])('mdast content seams reach %s', (_name, canvas, extra) => {
  it('renders math through the injected renderer', () => {
    const scene = layoutSpatialCanvas(canvas, baseOptions({ ...extra, ...SEAMS }))
    expect(svgOf(scene.nodes)).toContain('<g data-math="E = mc^2"/>')
  })

  it('renders a diagram fence through the injected renderer', () => {
    const scene = layoutSpatialCanvas(canvas, baseOptions({ ...extra, ...SEAMS }))
    expect(svgOf(scene.nodes)).toContain('<g data-mermaid="16"/>')
  })

  it('lays a resolved embed out inline', () => {
    const scene = layoutSpatialCanvas(canvas, baseOptions({ ...extra, ...SEAMS }))
    expect(textOf(scene.nodes)).toContain('EMBEDDED')
  })

  it('keeps the documented placeholders when no seam is supplied', () => {
    const scene = layoutSpatialCanvas(canvas, baseOptions(extra))
    // The math fallback carries the raw source as escaped text rather than
    // the injected renderer's output.
    expect(svgOf(scene.nodes).join('')).toContain('E = mc^2')
    expect(svgOf(scene.nodes)).not.toContain('<g data-math="E = mc^2"/>')
    expect(textOf(scene.nodes)).not.toContain('EMBEDDED')
  })
})
