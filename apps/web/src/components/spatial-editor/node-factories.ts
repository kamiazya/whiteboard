/**
 * Default-node construction, spawn-point resolution, and group-enclosure
 * math for the editor's node-creation family (palette buttons, the "Add X
 * here" context-menu items, group-from-selection). This fits none of the
 * three existing pure modules: `commands.ts` builds `EditorCommand`s over an
 * EXISTING canvas, not the `SpatialNode` values a command eventually
 * carries; `viewport.ts` is the pan/zoom transform, not node geometry;
 * `geometry.ts` is hit-testing/selection geometry over nodes that already
 * exist, not construction of new ones (though it supplies `findFreeSpot`,
 * which this module composes with an anchor override).
 *
 * Id minting is always caller-injected (every factory takes `id: string`)
 * — this file must never reference `crypto` or any other ambient id
 * source, so the purity-guard scan mechanically enforces the
 * injected-id-minting discipline the callers rely on for deterministic
 * tests.
 */
import type { CanvasKind, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type { Box } from './geometry.js'
import { findFreeSpot } from './geometry.js'
import { NEW_NODE_HEIGHT, NEW_NODE_WIDTH } from './gestures.js'
import type { Point } from './viewport.js'

/** Link nodes are label-only chrome — a note-height box would be mostly
 * empty, so they (and file-reference cards) get a shorter default. */
export const LINK_NODE_HEIGHT = 60

/**
 * A file node that renders a referenced markdown document's PROSE, rather
 * than a one-line reference card. At `LINK_NODE_HEIGHT` the padded content
 * box is 44px and not even a single heading block fits, so the body renders
 * as nothing and the node looks broken — verified in the running app. This
 * is the height at which a heading plus a few lines are readable; a user
 * who wants more resizes, which is the affordance that already exists.
 */
export const DOCUMENT_NODE_WIDTH = 320
export const DOCUMENT_NODE_HEIGHT = 220
/** Default frame for a created image node; the picture letterboxes into it. */
export const IMAGE_NODE_WIDTH = 240
export const IMAGE_NODE_HEIGHT = 180
export const GROUP_FRAME_WIDTH = 320
export const GROUP_FRAME_HEIGHT = 200
/** Padding between a grouped selection's bounds and its new frame. */
export const GROUP_PADDING_PX = 24

interface Size {
  readonly width: number
  readonly height: number
}

/** Shared box shape every factory below centers on `point`. */
function centeredBox(id: string, point: Point, size: Size) {
  return {
    id,
    x: Math.round(point.x - size.width / 2),
    y: Math.round(point.y - size.height / 2),
    width: size.width,
    height: size.height,
  }
}

export function textNodeDefaults(
  id: string,
  point: Point,
  text: string,
): Extract<SpatialNode, { type: 'text' }> {
  return {
    ...centeredBox(id, point, { width: NEW_NODE_WIDTH, height: NEW_NODE_HEIGHT }),
    type: 'text',
    text,
  }
}

export function linkNodeDefaults(
  id: string,
  point: Point,
  url: string,
): Extract<SpatialNode, { type: 'link' }> {
  return {
    ...centeredBox(id, point, { width: NEW_NODE_WIDTH, height: LINK_NODE_HEIGHT }),
    type: 'link',
    url,
  }
}

export function fileNodeDefaults(
  id: string,
  point: Point,
  file: string,
  /** What the reference points at; a markdown document gets a prose-sized box. */
  kind?: CanvasKind,
): Extract<SpatialNode, { type: 'file' }> {
  const box =
    kind === 'markdown'
      ? { width: DOCUMENT_NODE_WIDTH, height: DOCUMENT_NODE_HEIGHT }
      : { width: NEW_NODE_WIDTH, height: LINK_NODE_HEIGHT }
  return {
    ...centeredBox(id, point, box),
    type: 'file',
    file,
  }
}

/** Images ARE file nodes (JSON Canvas has no dedicated image type) — only
 * the default box shape differs from a plain file reference card. */
export function imageNodeDefaults(
  id: string,
  point: Point,
  file: string,
): Extract<SpatialNode, { type: 'file' }> {
  return {
    ...centeredBox(id, point, { width: IMAGE_NODE_WIDTH, height: IMAGE_NODE_HEIGHT }),
    type: 'file',
    file,
  }
}

export function groupNodeDefaults(
  id: string,
  point: Point,
): Extract<SpatialNode, { type: 'group' }> {
  return {
    ...centeredBox(id, point, { width: GROUP_FRAME_WIDTH, height: GROUP_FRAME_HEIGHT }),
    type: 'group',
  }
}

/**
 * Where a newly created node should spawn: the given anchor verbatim (the
 * user already chose "here" via the empty-space context menu), or else the
 * nearest non-colliding spot to `preferred` (the viewport-center button
 * path, which needs `findFreeSpot`'s cascade so repeated clicks do not
 * stack identical, unreachable boxes).
 */
export function resolveSpawnPoint(
  anchor: Point | undefined,
  preferred: Point,
  size: Size,
  occupied: readonly Box[],
  visible?: Box,
): Point {
  return anchor ?? findFreeSpot(preferred, size, occupied, visible)
}

export interface GroupEnclosure {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The padded frame enclosing every member box — `groupSelection`'s "frame
 * the current multi-selection" math. Undefined for an empty member list is
 * the no-op signal callers use to skip creating a degenerate group.
 */
export function groupEnclosure(
  members: readonly Box[],
  paddingPx: number = GROUP_PADDING_PX,
): GroupEnclosure | undefined {
  if (members.length === 0) return undefined
  const minX = Math.min(...members.map((m) => m.x)) - paddingPx
  const minY = Math.min(...members.map((m) => m.y)) - paddingPx
  const maxX = Math.max(...members.map((m) => m.x + m.width)) + paddingPx
  const maxY = Math.max(...members.map((m) => m.y + m.height)) + paddingPx
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
