/**
 * How ONE node is drawn and filled: the text body, the group background, the
 * frame and link cards, and `composeNode`, which chooses between them and the
 * file node's representations (`compose-file-node.ts`).
 *
 * The composer's other half, so it sits beside `spatial-canvas.ts` rather
 * than under `layout/nodes/`: it reads the composer's shared vocabulary
 * (`layout-options`, the scene transforms, the ink seed), which a `nodes/`
 * primitive may not reach up to (`layer-boundary.test.ts`). The box primitives
 * every kind is built from are `node-box.ts`'s, re-exported here so the
 * composer imports one module.
 *
 * A nested canvas — a file embed, a body's `![[canvas]]` — is laid out by the
 * composer's own entry, taken as `options.layoutNestedCanvas` rather than
 * imported: `spatial-canvas.ts` imports this module, so importing it back
 * would close a value cycle (as `comments.ts` and `proposals.ts` avoid it).
 */

import { resolveReferences } from '@kamiazya/whiteboard-codec'
import {
  frameBackground,
  frameBackgroundStyle,
  type NodeKind,
  nodeKind,
  nodeText,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import type { Scene, SceneNode } from '@kamiazya/whiteboard-scene'
import { referenceFor } from '../references/seams.js'
import { composeFileNode } from './compose-file-node.js'
import type { ResolvedLayoutOptions } from './layout-options.js'
import {
  chromeShape,
  chromeWithFit,
  contentWidth,
  fitSceneInNode,
  labelOf,
  labelRun,
  labelRuns,
  mdastOptionsFor,
  placeInNode,
} from './node-box.js'
import { type FittedBlocks, firstLineOfBlocks, typesetMdastBlocks } from './nodes/mdast-blocks.js'
import { collectTextRuns, composePassageHighlights, type NodePassage } from './passage-highlight.js'

export { mdastOptionsFor, nodeContentBounds, sketchInkFor } from './node-box.js'

/**
 * Composes a `text` node's chrome plus its laid-out markdown body. A
 * malformed body (one whose parsed mdast falls outside the caller's
 * accepted subset) degrades to a single literal text run rather than
 * aborting the canvas — this is the layer's own totality addition on top
 * of canvas-render's already-total layout functions.
 */
/**
 * The text node's own fit: the blocks that fit, but never fewer than one.
 *
 * A text node has no lower-ranked rendering to degrade to, so dropping
 * everything erases the user's own prose — and the box that keeps nothing is
 * not the pathological one, it is a node one line tall: at the default
 * padding a 25px-high node leaves 9px of content box for a ~16px line. That
 * is the same reasoning as `fitToWidth` never returning the empty string,
 * applied to the other axis. The block that stays squeezes the padding rather
 * than leaving the FRAME, which is the bound this whole fit exists to keep.
 *
 * The sibling seams keep `fitSceneInNode`'s `undefined` because they DO have
 * somewhere better to go — the plain chrome-and-label rendering.
 */
function fitTextBody(
  scene: Scene,
  node: SpatialNode,
  options: ResolvedLayoutOptions,
): FittedBlocks {
  // Keep-first's unit is a LINE, not a block: see `firstLineOfBlocks`.
  return fitSceneInNode(scene, node, options) ?? firstLineOfBlocks(scene.nodes)
}

function composeTextNode(node: SpatialNode, options: ResolvedLayoutOptions): readonly SceneNode[] {
  // The editor overlay owns this node's text: draw the chrome alone, with
  // no truncation mark — there is no drawn text for the mark to be about.
  if (options.suppressedBodyNodeIds?.includes(node.id)) return [chromeShape(node, options)]
  // Bound once: this function reads it three times, and the accessor exists
  // so no reader spells where the text is stored.
  const text = nodeText(node) ?? ''
  const maxWidth = contentWidth(node, options)
  // Position deliberately absent from the key: the cached value is
  // origin-relative (see `contentCache`'s contract), so a moved node hits.
  // The silhouette is part of the key: a shaped node lays out against its
  // inscribed box, so the same (width, height, text) fits differently.
  const cacheKey =
    options.contentCache === undefined
      ? undefined
      : JSON.stringify([
          node.width,
          node.height,
          text,
          options.nodeOutlines?.[node.id] ?? null,
          // A theme's family fits differently; two themes on one cache must
          // not hand each other the other's wrapped lines.
          options.appearance.resolveLabel().fontFamily ?? null,
          // The theme itself, which the family alone does not identify: one
          // naming no font of its own measures where a clean render does and
          // paints in its own ink, so the two looks would share an entry.
          options.activeTheme?.id ?? null,
        ])
  const cached = cacheKey === undefined ? undefined : options.contentCache?.get(cacheKey)
  let body: FittedBlocks
  if (cached !== undefined) {
    body = cached
  } else {
    try {
      const laid = typesetMdastBlocks(
        resolveReferences(options.parseBody(text), options.resolveAlias),
        mdastOptionsFor(maxWidth, options),
      )
      body = fitTextBody(laid, node, options)
      if (cacheKey !== undefined) options.contentCache?.set(cacheKey, body)
    } catch (err) {
      options.onDegrade?.({ kind: 'body-parse-failed', nodeId: node.id, err })
      body = fitTextBody({ nodes: [labelRun(text, options, maxWidth)] }, node, options)
    }
  }
  // Behind the runs, in the same origin-relative space, so `placeInNode`
  // carries them into the node together. A resolved passage is drawn only
  // with the resolved comments, muted like its pin.
  const passages = (options.passagesByNode.get(node.id) ?? []).filter(
    (passage) => !passage.resolved || options.showResolved === true,
  )
  const highlights =
    passages.length === 0
      ? []
      : composePassageHighlights(passages, collectTextRuns(body.nodes), options.measure, {
          open: options.appearance.resolveComment?.()?.passage,
          resolved: options.appearance.resolveComment?.()?.resolvedOverlay.passage,
        })
  return [
    chromeWithFit(node, options, body),
    ...placeInNode(node, { nodes: [...highlights, ...body.nodes] }, options),
  ]
}

export function groupPassages(
  passages: readonly NodePassage[],
): ReadonlyMap<string, readonly NodePassage[]> {
  const byNode = new Map<string, NodePassage[]>()
  for (const passage of passages) {
    const list = byNode.get(passage.nodeId) ?? []
    list.push(passage)
    byNode.set(passage.nodeId, list)
  }
  return byNode
}

/**
 * JSON Canvas group background: a full-frame image behind the members.
 * `backgroundStyle` maps 'ratio' -> contain and 'cover'/absent -> cover
 * (the spec's visual default); 'repeat' degrades to cover, reported via
 * `onDegrade`. Resolution failures keep the plain frame, matching the
 * file-image seam's never-throw rule.
 */
function composeGroupBackground(
  node: SpatialNode,
  options: ResolvedLayoutOptions,
): SceneNode | undefined {
  const background = frameBackground(node)
  if (background === undefined) return undefined
  const image = referenceFor(background, options.resolveReference)?.image
  if (image === undefined) return undefined
  if (!(node.width > 0) || !(node.height > 0)) return undefined
  const backgroundStyle = frameBackgroundStyle(node)
  if (backgroundStyle === 'repeat') {
    options.onDegrade?.({ kind: 'unsupported-background-style', nodeId: node.id, style: 'repeat' })
  }
  return {
    kind: 'image',
    bbox: { x: node.x, y: node.y, w: node.width, h: node.height },
    href: image.href,
    ...(image.alt !== undefined ? { alt: image.alt } : {}),
    fit: backgroundStyle === 'ratio' ? 'contain' : 'cover',
  }
}

/** Draws one kind of node. */
type NodeComposer = (node: SpatialNode, options: ResolvedLayoutOptions) => readonly SceneNode[]

/**
 * What each KIND of node draws. A table, so a kind added to `NodeKind` fails
 * here (`satisfies`) rather than arriving at a branch nobody wrote.
 */
const COMPOSE_BY_KIND = {
  file: composeFileNode,
  text: composeTextNode,
  frame: composeFrameNode,
  link: composeLinkNode,
} satisfies Record<NodeKind, NodeComposer>

export function composeNode(
  node: SpatialNode,
  options: ResolvedLayoutOptions,
): readonly SceneNode[] {
  const kind = nodeKind(node)
  // Unclaimed resource, or a kind cast past the type: chrome only, no throw.
  const compose: NodeComposer | undefined = kind === undefined ? undefined : COMPOSE_BY_KIND[kind]
  if (compose !== undefined) return compose(node, options)
  options.onDegrade?.({
    kind: 'unknown-node-kind',
    nodeId: node.id,
    // The media type, since `nodeKind` is `undefined` exactly when nothing
    // claims the resource.
    type: node.resource?.mimeType ?? 'none',
  })
  return [chromeShape(node, options)]
}

function composeFrameNode(node: SpatialNode, options: ResolvedLayoutOptions): readonly SceneNode[] {
  const chrome = chromeShape(node, options)
  const background = composeGroupBackground(node, options)
  return [
    chrome,
    ...(background === undefined ? [] : [background]),
    ...labelRuns(node, labelOf(node, undefined), 'above', options),
  ]
}

function composeLinkNode(node: SpatialNode, options: ResolvedLayoutOptions): readonly SceneNode[] {
  return [
    chromeShape(node, options),
    ...labelRuns(node, labelOf(node, undefined), 'inside', options),
  ]
}
