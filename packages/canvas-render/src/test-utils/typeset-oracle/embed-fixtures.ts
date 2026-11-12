import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type {
  MdastFlowContent,
  MdastPhrasingContent,
  MdastRoot,
} from '@kamiazya/whiteboard-model/mdast'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { selectCanvasFragment } from '../../canvas-fragment.js'
import { canvasElementCount } from '../../references/content-budget.js'
import type { EmbeddedDocument } from '../../references/resolved.js'

/**
 * What the embed seams answer for the typeset recording: a document or a canvas
 * per id, chosen by a hash of the id so a record can hold the table and a replay
 * needs no fixture. The canvases are summarised for the Rust side (how many
 * elements a fragment keeps, and whether it keeps none), because laying a canvas
 * out is the composer's and stays on the host.
 */

export interface EmbeddedWire {
  readonly kind: 'document' | 'canvas'
  readonly title: string | null
  /** The parsed body of a document target. */
  readonly root?: MdastRoot
}

/** What a fragment keeps of a canvas target: null where it names nothing. */
export type CanvasSummary = { readonly elements: number; readonly empty: boolean } | null

export type MiniatureMode = 'none' | 'throws' | 'shape' | 'tall'

const hashOf = (text: string): number => {
  let state = 0x811c_9dc5
  for (let i = 0; i < text.length; i += 1) {
    state = Math.imul(state ^ text.charCodeAt(i), 16_777_619) >>> 0
  }
  return state
}

const text = (value: string): MdastPhrasingContent => ({ type: 'text', value })
const embedOf = (documentId: string, fragment?: string): MdastPhrasingContent => ({
  type: 'embed',
  documentId,
  ...(fragment === undefined ? {} : { fragment }),
})
const para = (...children: MdastPhrasingContent[]): MdastFlowContent => ({
  type: 'paragraph',
  children,
})
const rootOf = (...children: MdastFlowContent[]): MdastRoot => ({ type: 'root', children })

/** The id the nth neighbour of an id's document embeds, so chains and loops arise by themselves. */
const neighbour = (id: string, step: number): string => `emb-${(hashOf(id) + step) % 16}`

function documentFor(id: string, withEmbeds: boolean): MdastRoot {
  const blocks: MdastFlowContent[] = [
    { type: 'heading', depth: 2, children: [text('Embedded')] },
    para(text(`Body of ${id.slice(-6)} that is long enough to wrap in a narrow box.`)),
    {
      type: 'list',
      ordered: false,
      children: [{ type: 'listItem', children: [para(text('item'))] }],
    },
    { type: 'heading', depth: 2, children: [text('Second')] },
    para(text('after the second heading')),
  ]
  if (withEmbeds) {
    blocks.push(para(embedOf(neighbour(id, 1))), para(text('between'), embedOf(neighbour(id, 2))))
    blocks.push(para(embedOf(neighbour(id, 3), 'Second')))
  }
  return rootOf(...blocks)
}

function canvasFor(variant: 'plain' | 'groups' | 'empty' | 'big'): SpatialCanvas {
  if (variant === 'empty') return { nodes: [], edges: [] }
  const node = (n: number) =>
    textNode({ id: `n${n}`, x: n * 200, y: 0, width: 160, height: 80, text: `node ${n}` })
  if (variant === 'big') {
    return { nodes: Array.from({ length: 2500 }, (_, n) => node(n)), edges: [] }
  }
  if (variant === 'plain') return { nodes: [node(1), node(2)], edges: [] }
  return {
    nodes: [
      groupNode({ id: 'g', x: 0, y: 0, width: 500, height: 200, label: 'Cluster' }),
      node(1),
      node(2),
      textNode({ id: 'out', x: 2000, y: 2000, width: 100, height: 40, text: 'outside' }),
    ],
    edges: [{ id: 'e1', from: { node: 'n1' }, to: { node: 'n2' } }],
  }
}

type Target = { title?: string; root: MdastRoot } | { title?: string; canvas: SpatialCanvas }

const memo = new Map<string, Target | null>()

/** What resolving an embed answers for an id; null where the target is not loaded. */
function targetFor(id: string): Target | null {
  const known = memo.get(id)
  if (known !== undefined) return known
  const variant = hashOf(`t${id}`) % 8
  const title = `Doc ${id.slice(-6)}`
  const made: Target | null = (() => {
    switch (variant) {
      case 0:
        return null
      case 1:
        return { title, root: documentFor(id, false) }
      case 2:
        return { root: documentFor(id, false) }
      case 3:
        return { title, canvas: canvasFor('plain') }
      case 4:
        return { title, canvas: canvasFor('groups') }
      case 5:
        return { title, root: documentFor(id, true) }
      case 6:
        return { title, canvas: canvasFor('empty') }
      default:
        return { title, canvas: canvasFor('big') }
    }
  })()
  memo.set(id, made)
  return made
}

export const embeddedDocumentOf = (id: string): EmbeddedDocument | undefined => {
  const target = targetFor(id)
  return target === null ? undefined : target
}

export function embeddedWireOf(id: string): EmbeddedWire | null {
  const target = targetFor(id)
  if (target === null) return null
  const title = target.title ?? null
  return 'canvas' in target
    ? { kind: 'canvas', title }
    : { kind: 'document', title, root: target.root }
}

export const fragmentKey = (id: string, fragment: string | undefined): string =>
  `${id}\u0000${fragment === undefined ? 'u' : `s${fragment}`}`

export function summaryOf(id: string, fragment: string | undefined): CanvasSummary {
  const target = targetFor(id)
  if (target === null || !('canvas' in target)) return null
  const canvas =
    fragment === undefined ? target.canvas : selectCanvasFragment(target.canvas, fragment)
  if (canvas === undefined) return null
  const elements = canvasElementCount(canvas)
  return { elements, empty: elements === 0 }
}

export function miniatureModeOf(id: string): MiniatureMode {
  return (['none', 'throws', 'shape', 'tall'] as const)[hashOf(`m${id}`) % 4] as MiniatureMode
}

/** The embeds an inline tree names, as `[id, fragment]`. */
function embedsIn(blocks: readonly MdastFlowContent[]): [string, string | undefined][] {
  const found: [string, string | undefined][] = []
  const inline = (nodes: readonly MdastPhrasingContent[]) => {
    for (const node of nodes) {
      if (node.type === 'embed') found.push([node.documentId, node.fragment])
      if ('children' in node) inline(node.children)
    }
  }
  const flow = (list: readonly MdastFlowContent[]) => {
    for (const block of list) {
      if (block.type === 'paragraph' || block.type === 'heading') inline(block.children)
      if (block.type === 'blockquote') flow(block.children)
      if (block.type === 'list') for (const item of block.children) flow(item.children)
      if (block.type === 'table') {
        for (const row of block.children) for (const cell of row.children) inline(cell.children)
      }
    }
  }
  flow(blocks)
  return found
}

/**
 * Everything the embeds of a tree can reach: every id, every `(id, fragment)`
 * asked of it, and the bodies of the documents among them, which are laid out
 * in their turn and so name embeds of their own.
 */
export function embedClosure(root: MdastRoot): {
  readonly pairs: ReadonlyMap<string, [string, string | undefined]>
  readonly roots: readonly MdastRoot[]
} {
  const pairs = new Map<string, [string, string | undefined]>()
  const roots: MdastRoot[] = []
  const seen = new Set<string>()
  const visit = (blocks: readonly MdastFlowContent[]) => {
    for (const [id, fragment] of embedsIn(blocks)) {
      pairs.set(fragmentKey(id, fragment), [id, fragment])
      if (seen.has(id)) continue
      seen.add(id)
      const target = targetFor(id)
      if (target !== null && 'root' in target) {
        roots.push(target.root)
        visit(target.root.children)
      }
    }
  }
  visit(root.children)
  return { pairs, roots }
}
