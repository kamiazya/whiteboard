import { frameHolds, isFrame, type SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MutableRefObject, RefObject } from 'react'
import type { FileRefOption } from '../../lib/link-entries.js'
import { defaultCreateId } from '../../lib/spatial/element-id.js'
import { creationObstacles, PLACEMENT_GAP_PX } from '../../lib/spatial/frame-interior.js'
import { type Box, boxesIntersect, findFreeSpot } from '../../lib/spatial/geometry.js'
import { nextInRow } from '../../lib/spatial/row-placement.js'
import type { ContainerSize, Point, Viewport } from '../../lib/spatial/viewport.js'
import { panToShowTarget, screenToCanvas } from '../../lib/spatial/viewport.js'
import type { GestureResult } from './gestures.js'
import { NEW_NODE_HEIGHT, NEW_NODE_WIDTH } from './gestures.js'
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

const GROUP_FRAME_SIZE = { width: GROUP_FRAME_WIDTH, height: GROUP_FRAME_HEIGHT }
const NOTE_SIZE = { width: NEW_NODE_WIDTH, height: NEW_NODE_HEIGHT }

/**
 * How far above a frame its own chrome reaches: the name sits over the top
 * edge, and once selected so does its tool chip — 44px on a touch screen
 * plus its 6px gap. A frame placed flush under a note would draw both over
 * that note.
 */
const FRAME_TOP_CLEARANCE_PX = 50

/**
 * What a new frame must keep clear of: each obstacle grown by `gap` on every
 * side, and reaching down over the frame's top strip.
 */
function frameObstacles(canvas: SpatialCanvas, gap: number): readonly Box[] {
  return creationObstacles(canvas).map((box) => ({
    x: box.x - gap,
    y: box.y - gap,
    width: box.width + gap * 2,
    height: box.height + gap + Math.max(gap, FRAME_TOP_CLEARANCE_PX),
  }))
}

/** The box a frame centred on `at` covers. */
function frameBoxAt(at: Point): Box {
  const { width, height } = GROUP_FRAME_SIZE
  return { x: at.x - width / 2, y: at.y - height / 2, width, height }
}

/**
 * Where a frame asked for at `at` goes: `at` itself when the frame covers
 * nothing there, else the free spot nearest it. A frame holds whatever it
 * covers, so one dropped over another frame took that frame's notes and hid
 * its name.
 */
function frameSpawnPoint(at: Point, obstacles: readonly Box[], visible: Box | undefined): Point {
  if (!obstacles.some((other) => boxesIntersect(frameBoxAt(at), other))) return at
  return findFreeSpot(at, GROUP_FRAME_SIZE, obstacles, visible)
}

/**
 * Where the next frame of a board's run goes when nobody pointed: right of
 * the last row of top-level frames, on its top line, wrapping below — so
 * frames made one after another read in the order they were made. Only while
 * some of that row is on screen; a person who panned away is asking for the
 * view they are looking at. Undefined leaves the choice to `placeFrame`.
 */
function frameInRow(canvas: SpatialCanvas, visible: Box | undefined): Point | undefined {
  const frames = canvas.nodes.filter(isFrame)
  const topLevel = frames.filter(
    (frame) => !frames.some((other) => other.id !== frame.id && frameHolds(other, frame)),
  )
  const [first, ...rest] = topLevel
  if (first === undefined) return undefined
  if (visible !== undefined && !topLevel.some((frame) => boxesIntersect(frame, visible)))
    return undefined
  const corner = nextInRow({
    peers: [first, ...rest],
    size: GROUP_FRAME_SIZE,
    obstacles: frameObstacles(canvas, PLACEMENT_GAP_PX),
    visible,
    gap: PLACEMENT_GAP_PX,
    // A row's bottom, the gap, then the next row's name strip.
    rowGap: PLACEMENT_GAP_PX + FRAME_TOP_CLEARANCE_PX,
  })
  return { x: corner.x + GROUP_FRAME_SIZE.width / 2, y: corner.y + GROUP_FRAME_SIZE.height / 2 }
}

/** What a new note must keep clear of: each obstacle grown by `gap` on every side. */
function noteObstacles(canvas: SpatialCanvas, gap: number): readonly Box[] {
  return creationObstacles(canvas).map((box) => ({
    x: box.x - gap,
    y: box.y - gap,
    width: box.width + gap * 2,
    height: box.height + gap * 2,
  }))
}

/**
 * Where a note asked for with nothing selected goes: after the board's loose
 * notes in reading order, the way `frameInRow` places frames, while some of
 * them are on screen; else the free spot nearest `preferred` a gap clear of
 * everything, and only failing that one merely clear of it.
 */
function placeLooseNote(canvas: SpatialCanvas, preferred: Point, visible: Box | undefined): Point {
  const frames = canvas.nodes.filter(isFrame)
  const loose = canvas.nodes.filter(
    (node) => !isFrame(node) && !frames.some((frame) => frameHolds(frame, node)),
  )
  const spaced = noteObstacles(canvas, PLACEMENT_GAP_PX)
  const [first, ...rest] = loose
  if (
    first !== undefined &&
    (visible === undefined || loose.some((node) => boxesIntersect(node, visible)))
  ) {
    const corner = nextInRow({
      peers: [first, ...rest],
      size: NOTE_SIZE,
      obstacles: spaced,
      visible,
      gap: PLACEMENT_GAP_PX,
      rowGap: PLACEMENT_GAP_PX,
    })
    return { x: corner.x + NOTE_SIZE.width / 2, y: corner.y + NOTE_SIZE.height / 2 }
  }
  const point = findFreeSpot(preferred, NOTE_SIZE, spaced, visible)
  const box = {
    x: Math.round(point.x - NOTE_SIZE.width / 2),
    y: Math.round(point.y - NOTE_SIZE.height / 2),
    ...NOTE_SIZE,
  }
  const fits =
    !spaced.some((other) => boxesIntersect(box, other)) &&
    (visible === undefined || frameHolds(visible, box))
  return fits ? point : findFreeSpot(preferred, NOTE_SIZE, creationObstacles(canvas), visible)
}

/**
 * A new frame keeps the gap boxes keep from each other — under it, a frame
 * beside a note reads as part of it — where there is room for that. The gap
 * gives way before the frame's other promises do: a spaced spot off screen
 * loses to an unspaced one on it, since chasing a frame off the view is
 * worse than a tight fit, and a canvas too full for the gap anywhere places
 * the frame the way it did without one.
 */
function placeFrame(at: Point, canvas: SpatialCanvas, visible: Box | undefined): Point {
  const attempt = (gap: number) => {
    const obstacles = frameObstacles(canvas, gap)
    const point = frameSpawnPoint(at, obstacles, visible)
    const box = frameBoxAt(point)
    return {
      point,
      free: !obstacles.some((other) => boxesIntersect(box, other)),
      seen: visible === undefined || frameHolds(visible, box),
    }
  }
  const spaced = attempt(PLACEMENT_GAP_PX)
  const tight = attempt(0)
  if (spaced.free && spaced.seen) return spaced.point
  if (tight.free && tight.seen) return tight.point
  return spaced.free ? spaced.point : tight.point
}

/**
 * Where Add > Frame puts a frame: a point somebody chose keeps the frame off
 * what is there; otherwise the row of frames goes on, or failing that the
 * view's centre does.
 */
function frameSpawn(
  canvas: SpatialCanvas,
  at: Point | undefined,
  viewCenter: () => Point,
  visible: Box | undefined,
): Point {
  if (at !== undefined) return placeFrame(at, canvas, visible)
  return frameInRow(canvas, visible) ?? placeFrame(viewCenter(), canvas, visible)
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

  /** The canvas point at the middle of the editor's box. */
  const viewCenter = (): Point => {
    const root = rootRef.current
    const centerScreen =
      root === null ? { x: 0, y: 0 } : { x: root.clientWidth / 2, y: root.clientHeight / 2 }
    return screenToCanvas(centerScreen, viewport)
  }

  /** Where Add > Note puts a note when no frame asks for it; see `placeLooseNote`. */
  const placeNote = (preferred: Point): Point =>
    placeLooseNote(canvasRef.current, preferred, visibleCanvasRect())

  const spawnPoint = (at: Point | undefined, size: { width: number; height: number }): Point => {
    const occupied = creationObstacles(canvasRef.current)
    return resolveSpawnPoint(at, viewCenter(), size, occupied, visibleCanvasRect())
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
    const point = frameSpawn(canvasRef.current, at, viewCenter, visibleCanvasRect())
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
    placeNote,
    panToShow,
    createLinkAtViewportCenter,
    createFileRefAtViewportCenter,
    createImageNodeAt,
    createGroupAtViewportCenter,
    groupSelection,
  }
}
