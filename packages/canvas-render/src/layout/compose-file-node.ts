import { nodeFile, type SpatialNode } from '@kamiazya/whiteboard-model'
import type { MdastFlowContent } from '@kamiazya/whiteboard-model/mdast'
import type { SceneNode } from '@kamiazya/whiteboard-scene'
import type { ResolvedReference } from '../references/resolved.js'
import type { ResolvedLayoutOptions } from './layout-options.js'
import {
  chromeShape,
  chromeWithFit,
  fitBodyInNode,
  labelOf,
  labelRun,
  labelRuns,
  placeAboveNode,
  placeInNode,
  referenceFor,
} from './node-box.js'
import type { FittedBlocks } from './nodes/mdast-blocks.js'
import { fitSceneIntoBox } from './scale-scene.js'

/** Root is 0, the 4th level degrades — the same cap `mdast-blocks.ts` pins for a body's embeds. */
const FILE_EMBED_DEPTH_CAP = 3

/**
 * The inline-embedded rendering of a file node: the referenced canvas laid
 * out at native size, scaled to fit the node's content area (never
 * upscaled), and placed under the label band. Returns undefined whenever
 * the card should render instead — no resolver, policy says collapsed,
 * unresolvable reference, cycle on the current path, depth cap, or a
 * degenerate fit.
 */
function composeFileEmbed(
  node: SpatialNode,
  resolved: ResolvedReference | undefined,
  options: ResolvedLayoutOptions,
): SceneNode | undefined {
  const child = resolved?.canvas
  if (child === undefined) return undefined
  if (options.expandFileNode?.(node) !== true) return undefined
  const file = nodeFile(node)
  if (
    file === undefined ||
    options.embedDepth >= FILE_EMBED_DEPTH_CAP ||
    options.activeEmbedPath.has(file)
  ) {
    return undefined
  }

  const childScene = options.layoutNestedCanvas(child, {
    ...options,
    // Silhouettes resolve per CANVAS (in withCanvasTheme), keyed by that
    // canvas's own node ids: spreading the parent's map both drops the
    // child's facets and leaks a same-id root node's shape into the embedded
    // canvas. Explicit per-node overrides are root-keyed by contract, so
    // they do not descend.
    explicitNodeOutlines: undefined,
    activeEmbedPath: new Set([...options.activeEmbedPath, file]),
    embedDepth: options.embedDepth + 1,
  })
  const padding = options.geometry.paddingPx
  // The reference label sits OUTSIDE the frame (see placeAboveNode), so
  // the miniature gets the whole padded box.
  const fitted = fitSceneIntoBox(childScene, {
    x: node.x + padding,
    y: node.y + padding,
    maxWidth: node.width - 2 * padding,
    maxHeight: node.height - 2 * padding,
  })
  if (fitted === undefined) return undefined
  return {
    kind: 'embedResolved',
    bbox: { x: node.x, y: node.y, w: node.width, h: node.height },
    documentId: file,
    children: fitted.nodes,
  }
}

/** The image rendering of a file node: fills the padded box, aspect kept. */
function composeFileImage(
  node: SpatialNode,
  resolved: ResolvedReference | undefined,
  options: ResolvedLayoutOptions,
): SceneNode | undefined {
  const image = resolved?.image
  if (image === undefined) return undefined
  const padding = options.geometry.paddingPx
  const w = node.width - 2 * padding
  const h = node.height - 2 * padding
  if (!(w > 0) || !(h > 0)) return undefined
  return {
    kind: 'image',
    bbox: { x: node.x + padding, y: node.y + padding, w, h },
    href: image.href,
    ...(image.alt !== undefined ? { alt: image.alt } : {}),
  }
}

/**
 * The markdown-body rendering of a file node: the referenced document's
 * own prose laid out inline in the node's content area, with the reference
 * label placed OUTSIDE the frame exactly as `composeFileEmbed` does — both
 * seams turn the node into a container showing another document, so they
 * must read the same way.
 *
 * Returns `undefined` — falling through to the facet card, then the plain
 * label — for every "nothing to show" path: no resolver, an `undefined` or
 * thrown result, an empty body, or a box too small for even one block.
 * Like every other file seam this is the expected common case rather than
 * an error, so it is never reported via `onDegrade`.
 */
function composeFileMarkdown(
  node: SpatialNode,
  resolved: ResolvedReference | undefined,
  options: ResolvedLayoutOptions,
): readonly SceneNode[] | undefined {
  const root = resolved?.markdown
  if (root === undefined) return undefined

  // The LAYOUT is guarded too, not just the resolver call. This seam is the
  // first to feed caller-supplied mdast straight into `layoutMdastBlocks`:
  // `composeTextNode` parses its own via `parseBody` (and catches), and
  // `composeFileFacets` builds its blocks internally, so both were total by
  // construction. `layoutBlock`'s switch has no default case and dereferences
  // per-kind fields, so a child the caller's own validation let through — a
  // null, a primitive, an unrecognised `type` — throws from here and, with no
  // per-node guard in the composition loop, takes the WHOLE canvas with it.
  // That would break this package's documented never-throw rule
  // (package-canvas-render.md) at the one seam that made it reachable.
  let body: FittedBlocks | undefined
  try {
    body = fitBodyInNode(node, root, options)
  } catch (err) {
    options.onDegrade?.({ kind: 'body-parse-failed', nodeId: node.id, err })
    return undefined
  }
  if (body === undefined) return undefined

  const chrome = chromeWithFit(node, options, body)
  const label = labelOf(node, resolved)
  const placed = placeInNode(node, { nodes: body.nodes }, options)
  return label === undefined
    ? [chrome, ...placed]
    : [
        chrome,
        ...placeAboveNode(node, { nodes: [labelRun(label, options, node.width)] }),
        ...placed,
      ]
}

/**
 * The facet-card rendering of a file node: a bare heading line (the card's
 * `title`) followed by one paragraph per row (`label: value`), laid out
 * through `layoutMdastBlocks` — the same producer `composeTextNode` uses —
 * rather than a second text-layout producer (package-canvas-render.md's
 * "one producer per geometry" rule). Deliberately only `heading`/
 * `paragraph` blocks: `list`/`table` are the only two block renderers that
 * emit their own SVG `transform` (the `subtreeOffsetX` class), and this
 * card has no reason to enter that tripwire.
 *
 * Returns `undefined` — keeping the plain chrome+label rendering — for
 * every "no usable content" path: no resolver, an `undefined` or thrown
 * result, a title that is empty/whitespace-only with no usable row, or a
 * degenerate (non-positive) content box. This is the expected common case,
 * not an error: the model guarantees payloads this layer cannot validate,
 * so canvas-render never reports it via `onDegrade`.
 */
function composeFileFacets(
  node: SpatialNode,
  resolved: ResolvedReference | undefined,
  options: ResolvedLayoutOptions,
): readonly SceneNode[] | undefined {
  const card = resolved?.facets
  if (card === undefined) return undefined

  const title = card.title?.trim() ? card.title : undefined
  const rows = card.rows.filter((row) => row.label.trim().length > 0 || row.value.trim().length > 0)
  if (title === undefined && rows.length === 0) return undefined

  const blocks: MdastFlowContent[] = []
  if (title !== undefined) {
    blocks.push({ type: 'heading', depth: 3, children: [{ type: 'text', value: title }] })
  }
  for (const row of rows) {
    blocks.push({
      type: 'paragraph',
      children: [
        { type: 'strong', children: [{ type: 'text', value: row.label }] },
        { type: 'text', value: `: ${row.value}` },
      ],
    })
  }

  const body = fitBodyInNode(node, { type: 'root', children: blocks }, options)
  if (body === undefined) return undefined

  return [chromeWithFit(node, options, body), ...placeInNode(node, { nodes: body.nodes }, options)]
}

/** One way a file node can show what it points at, or `undefined` to pass. */
type FileRepresentation = (
  node: SpatialNode,
  resolved: ResolvedReference | undefined,
  options: ResolvedLayoutOptions,
) => readonly SceneNode[] | undefined

/**
 * How a file node shows its reference, in RANK order (decision #11): the
 * first that answers draws the node; none answering leaves the label.
 */
const FILE_REPRESENTATIONS: readonly FileRepresentation[] = [
  // Full-bleed image, no label run — the filename would overlap the picture;
  // the accessible name travels on the image node itself.
  (node, resolved, options) => {
    const image = composeFileImage(node, resolved, options)
    return image === undefined ? undefined : [chromeShape(node, options), image]
  },
  (node, resolved, options) => {
    const embed = composeFileEmbed(node, resolved, options)
    return embed === undefined
      ? undefined
      : [
          chromeShape(node, options),
          ...labelRuns(node, labelOf(node, resolved), 'above', options),
          embed,
        ]
  },
  composeFileMarkdown,
  composeFileFacets,
]

export function composeFileNode(
  node: SpatialNode,
  options: ResolvedLayoutOptions,
): readonly SceneNode[] {
  // Resolved ONCE and threaded through every rank. `?? ''` is unreachable —
  // a `file` IS "has a location" — and would resolve to nothing, not throw.
  const resolved = referenceFor(nodeFile(node) ?? '', options)
  for (const represent of FILE_REPRESENTATIONS) {
    const drawn = represent(node, resolved, options)
    if (drawn !== undefined) return drawn
  }
  return [
    chromeShape(node, options),
    ...labelRuns(node, labelOf(node, resolved), 'inside', options),
  ]
}
