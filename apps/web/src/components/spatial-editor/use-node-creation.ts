import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MutableRefObject, RefObject } from 'react'
import type { FileRefOption } from '../../lib/link-entries.js'
import type { Box } from '../../lib/spatial/geometry.js'
import { indexNodeBoxes } from '../../lib/spatial/geometry.js'
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

export interface NodeCreationInputs {
  readonly rootRef: RefObject<HTMLDivElement | null>
  /** The editor's always-current canvas mirror. */
  readonly canvasRef: MutableRefObject<SpatialCanvas>
  readonly viewport: Viewport
  readonly setViewport: (updater: (vp: Viewport) => Viewport) => void
  readonly createId: (() => string) | undefined
  readonly fileRefOptions: readonly FileRefOption[] | undefined
  readonly onAddImage: ((file: File) => Promise<string | undefined>) | undefined
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
  onAddImage,
  applyResult,
  collapseExtras,
  containerSizeOf,
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

  const newId = () =>
    createId?.() ??
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : String(Math.random()))

  const spawnPoint = (at: Point | undefined, size: { width: number; height: number }): Point => {
    const root = rootRef.current
    const centerScreen =
      root === null ? { x: 0, y: 0 } : { x: root.clientWidth / 2, y: root.clientHeight / 2 }
    const preferred = screenToCanvas(centerScreen, viewport)
    const occupied = indexNodeBoxes(canvasRef.current).map((b) => b.box)
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

  /** Stores the image via the host seam, then creates the node. */
  const addImageFile = (file: File, at?: Point) => {
    if (onAddImage === undefined || !file.type.startsWith('image/')) return
    void onAddImage(file).then((ref) => {
      if (ref !== undefined) createImageNodeAt(ref, at)
    })
  }

  const createGroupAtViewportCenter = (at?: Point) => {
    const point = spawnPoint(at, { width: GROUP_FRAME_WIDTH, height: GROUP_FRAME_HEIGHT })
    const id = newId()
    const node = groupNodeDefaults(id, point)
    applyResult({
      state: { kind: 'idle' },
      commands: [{ kind: 'create-group', node }],
      selectedId: id,
    })
    collapseExtras()
    panToShow({ x: node.x, y: node.y, width: node.width, height: node.height })
  }

  /** Frames the current multi-selection: enclosing box + padding. */
  const groupSelection = (memberIds: readonly string[]) => {
    const members = canvasRef.current.nodes.filter((n) => memberIds.includes(n.id))
    const frame = groupEnclosure(members)
    if (frame === undefined) return
    const id = newId()
    applyResult({
      state: { kind: 'idle' },
      commands: [{ kind: 'create-group', node: { id, type: 'group', ...frame } }],
      selectedId: id,
    })
    collapseExtras()
  }

  return {
    visibleCanvasRect,
    panToShow,
    createLinkAtViewportCenter,
    createFileRefAtViewportCenter,
    createImageNodeAt,
    addImageFile,
    createGroupAtViewportCenter,
    groupSelection,
  }
}
