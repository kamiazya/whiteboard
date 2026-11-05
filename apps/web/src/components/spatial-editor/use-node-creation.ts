import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MutableRefObject, RefObject } from 'react'
import type { FileRefOption } from '../../lib/link-entries.js'
import { defaultCreateId } from '../../lib/spatial/element-id.js'
import { creationObstacles } from '../../lib/spatial/frame-interior.js'
import { type Box, boxesIntersect, findFreeSpot } from '../../lib/spatial/geometry.js'
import type { ContainerSize, Point, Viewport } from '../../lib/spatial/viewport.js'
import { panToShowTarget, screenToCanvas } from '../../lib/spatial/viewport.js'
import type { GestureResult } from './gestures.js'
import { NEW_NODE_WIDTH } from './gestures.js'
import {
  DOCUMENT_NODE_HEIGHT,
  DOCUMENT_NODE_WIDTH,
  fileNodeDefaults,
  GROUP_FRAME_HEIGHT,
  GROUP_FRAME_WIDTH,
  groupEnclosure,
  groupNodeDefaults,
  IMAGE_NODE_HEIGHT,
  IMAGE_NODE_WIDTH,
  imageNodeDefaults,
  LINK_NODE_HEIGHT,
  linkNodeDefaults,
  resolveSpawnPoint,
} from './node-factories.js'
import { DOCK_OCCLUSION_PX } from './ToolPalette.js'

/** Whether a `size` box centred on `center` overlaps none of `obstacles`. */
function isFreeAt(
  center: Point,
  size: { readonly width: number; readonly height: number },
  obstacles: readonly Box[],
): boolean {
  const box = {
    x: center.x - size.width / 2,
    y: center.y - size.height / 2,
    width: size.width,
    height: size.height,
  }
  return !obstacles.some((other) => boxesIntersect(box, other))
}

export interface NodeCreationInputs {
  readonly rootRef: RefObject<HTMLDivElement | null>
  /** The editor's always-current canvas mirror. */
  readonly canvasRef: MutableRefObject<SpatialCanvas>
  readonly viewport: Viewport
  readonly setViewport: (updater: (vp: Viewport) => Viewport) => void
  readonly createId: (() => string) | undefined
  readonly fileRefOptions: readonly FileRefOption[] | undefined
  /**
   * The command sink: the same applyResult every gesture goes through, so a
   * palette/menu creation writes the canvas, the selection primary and the
   * gesture state exactly as a pointer-driven one would.
   */
  readonly applyResult: (result: GestureResult) => void
  /**
   * Creation selects the new node EXCLUSIVELY — applyResult's selectedId
   * sets the primary, and this drops the old extras that would otherwise
   * ride along into the next move/delete.
   */
  readonly collapseExtras: () => void
  readonly containerSizeOf: (root: HTMLDivElement | null) => ContainerSize | null
  /** Opens the name editor on a frame the person just asked for. */
  readonly openGroupLabel: (id: string) => void
}

/**
 * The spawn-at-a-point creation family — everything the palette, the
 * context menu and drops create WITHOUT a gesture: link, file-reference,
 * image and group nodes, plus the group-the-selection verb. The
 * double-press note creator stays in the editor: it goes through the
 * gesture reducer, not this family's idle-state results.
 *
 * The free-spot cascade can push a created node outside the visible
 * viewport, leaving the user staring at an unchanged canvas. When the
 * created box does not fully fit on screen, `panToShow` pans (keeping the
 * zoom) so it sits centered — creation is always visible feedback.
 */
export function useNodeCreation({
  rootRef,
  canvasRef,
  viewport,
  setViewport,
  createId,
  fileRefOptions,
  applyResult,
  collapseExtras,
  containerSizeOf,
  openGroupLabel,
}: NodeCreationInputs) {
  /**
   * The canvas-space rectangle a person can actually see: the root, minus
   * the strip the dock paints over. Creation places inside this before it
   * places anywhere else, which is what keeps the view still.
   */
  const visibleCanvasRect = (): Box | undefined => {
    const containerSize = containerSizeOf(rootRef.current)
    if (containerSize === null) return undefined
    const topLeft = screenToCanvas({ x: 0, y: 0 }, viewport)
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: containerSize.width / viewport.zoom,
      height: (containerSize.height - DOCK_OCCLUSION_PX) / viewport.zoom,
    }
  }

  const panToShow = (box: Box) => {
    const containerSize = containerSizeOf(rootRef.current)
    if (containerSize === null) return
    setViewport(
      (vp) => panToShowTarget(box, vp, containerSize, { bottom: DOCK_OCCLUSION_PX }) ?? vp,
    )
  }

  // The one id generator, not a second copy of it: this had drifted into
  // its own inline `crypto.randomUUID`/`Math.random` chain while five other
  // call sites used `defaultCreateId`.
  const newId = () => (createId ?? defaultCreateId)()

  const spawnPoint = (at: Point | undefined, size: { width: number; height: number }): Point => {
    const root = rootRef.current
    const centerScreen =
      root === null ? { x: 0, y: 0 } : { x: root.clientWidth / 2, y: root.clientHeight / 2 }
    const preferred = screenToCanvas(centerScreen, viewport)
    const occupied = creationObstacles(canvasRef.current)
    return resolveSpawnPoint(at, preferred, size, occupied, visibleCanvasRect())
  }

  const createLinkAtViewportCenter = (url: string, at?: Point) => {
    const point = spawnPoint(at, { width: NEW_NODE_WIDTH, height: LINK_NODE_HEIGHT })
    const id = newId()
    const node = linkNodeDefaults(id, point, url)
    applyResult({
      state: { kind: 'idle' },
      commands: [{ kind: 'create-node', node }],
      selectedId: id,
    })
    collapseExtras()
    panToShow({ x: node.x, y: node.y, width: node.width, height: node.height })
  }

  /** File nodes are reference cards like links — same shorter default box. */
  const createFileRefAtViewportCenter = (file: string, at?: Point) => {
    // The picked option's kind decides the box: a markdown document
    // renders its prose inside the node and needs room a one-line
    // reference card does not have.
    const kind = fileRefOptions?.find((option) => option.file === file)?.kind
    const point = spawnPoint(
      at,
      kind === 'markdown'
        ? { width: DOCUMENT_NODE_WIDTH, height: DOCUMENT_NODE_HEIGHT }
        : { width: NEW_NODE_WIDTH, height: LINK_NODE_HEIGHT },
    )
    const id = newId()
    const node = fileNodeDefaults(id, point, file, kind)
    applyResult({
      state: { kind: 'idle' },
      commands: [{ kind: 'create-node', node }],
      selectedId: id,
    })
    collapseExtras()
    panToShow({ x: node.x, y: node.y, width: node.width, height: node.height })
  }

  const createImageNodeAt = (file: string, at?: Point) => {
    const point = spawnPoint(at, { width: IMAGE_NODE_WIDTH, height: IMAGE_NODE_HEIGHT })
    const id = newId()
    const node = imageNodeDefaults(id, point, file)
    applyResult({
      state: { kind: 'idle' },
      commands: [{ kind: 'create-node', node }],
      selectedId: id,
    })
    collapseExtras()
    panToShow({ x: node.x, y: node.y, width: node.width, height: node.height })
  }

  /**
   * A new, empty frame, asked for by name: in free space near the view's
   * centre (or nearest the point the canvas menu was opened on), selected, with
   * its name editor open, since an unnamed empty frame has nothing to find
   * it by. It never wraps the selection — framing what is selected is the
   * menu's Frame selection, and a frame that silently nested around the
   * selected one left its name unasked and the typing landing on the canvas.
   */
  const createGroupAtViewportCenter = (at?: Point) => {
    const size = { width: GROUP_FRAME_WIDTH, height: GROUP_FRAME_HEIGHT }
    // A point is kept only when the frame fits there without covering
    // anything: a frame holds whatever it covers, so one dropped over another
    // frame took that frame's notes and hid its name. Otherwise the point is
    // where the search for free space starts.
    const obstacles = creationObstacles(canvasRef.current)
    const point =
      at === undefined
        ? spawnPoint(undefined, size)
        : isFreeAt(at, size, obstacles)
          ? at
          : findFreeSpot(at, size, obstacles, visibleCanvasRect())
    const id = newId()
    const node = groupNodeDefaults(id, point)
    applyResult({
      state: { kind: 'idle' },
      commands: [{ kind: 'create-group', node }],
      selectedId: id,
    })
    collapseExtras()
    panToShow({ x: node.x, y: node.y, width: node.width, height: node.height })
    openGroupLabel(id)
  }

  /** Frames the current multi-selection: enclosing box + padding. */
  const groupSelection = (memberIds: readonly string[]) => {
    const members = canvasRef.current.nodes.filter((n) => memberIds.includes(n.id))
    const frame = groupEnclosure(members)
    if (frame === undefined) return
    const id = newId()
    applyResult({
      state: { kind: 'idle' },
      // No resource: a frame shows nothing.
      commands: [{ kind: 'create-group', node: { id, ...frame } }],
      selectedId: id,
    })
    collapseExtras()
    openGroupLabel(id)
  }

  return {
    visibleCanvasRect,
    panToShow,
    createLinkAtViewportCenter,
    createFileRefAtViewportCenter,
    createImageNodeAt,
    createGroupAtViewportCenter,
    groupSelection,
  }
}
