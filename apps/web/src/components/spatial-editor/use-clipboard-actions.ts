import type { ClipboardFragment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MutableRefObject } from 'react'
import { extractClipboardFragment } from '../../lib/clipboard-fragment.js'
import {
  readClipboardFragment,
  recordedReconnection,
  recordReconnection,
  writeClipboardFragment,
} from '../../lib/clipboard-store.js'
import type { EditorCommand } from '../../lib/spatial/commands.js'
import {
  applyCommand,
  buildFragmentInsertCommand,
  DUPLICATE_OFFSET_PX,
} from '../../lib/spatial/commands.js'
import type { Point, Viewport } from '../../lib/spatial/viewport.js'
import { screenToCanvas } from '../../lib/spatial/viewport.js'
import { textNodeDefaults } from './node-factories.js'

/**
 * The deferred half of a cut: the originals stay on the canvas as a ghost
 * until the paste decides what the cut meant (move here, copy elsewhere,
 * or nothing). `snapshot` records each held node's full serialized value
 * at cut time so ANY change reads as "someone touched it" and cancels the
 * hold.
 */
export interface PendingCut {
  readonly cutId: string
  readonly snapshot: ReadonlyMap<string, string>
}

export interface ClipboardActionsInputs {
  /** The editor's always-current canvas mirror. */
  readonly canvasRef: MutableRefObject<SpatialCanvas>
  /** The primary selected node's id, when a node selection exists. */
  readonly primaryId: string | undefined
  readonly extraIds: Iterable<string>
  readonly pendingCut: PendingCut | null
  readonly setPendingCut: (next: PendingCut | null) => void
  readonly onChange: (next: SpatialCanvas, command: EditorCommand) => void
  readonly createId: (() => string) | undefined
  /**
   * The selection seam: make exactly these nodes the selection (primary
   * first) and drop any edge selection. The hook never writes selection
   * state directly — this keeps the primary/extras invariant and the
   * node/edge exclusivity where they are enforced, in the editor.
   */
  readonly selectNodes: (ids: readonly string[]) => void
  readonly viewport: Viewport
  /** Root-local screen point at the middle of the visible canvas. */
  readonly viewportCenterScreen: () => Point
}

/**
 * The clipboard family — copy/cut/paste/duplicate plus the foreign-text
 * fallback note. Every canvas mutation goes through applyCommand and out
 * through `onChange`; every selection write goes through `selectNodes`.
 * Plain per-render closures, exactly as they were inside the editor body.
 */
export function useClipboardActions({
  canvasRef,
  primaryId,
  extraIds,
  pendingCut,
  setPendingCut,
  onChange,
  createId,
  selectNodes,
  viewport,
  viewportCenterScreen,
}: ClipboardActionsInputs) {
  /**
   * Clones the selection as ONE batch command (one undo step): reminted
   * ids via the clipboard-fragment helpers, +16px offset (the standard
   * duplicate-again cascade), edges kept only when both endpoints are
   * selected — with their properties. The copies become the selection.
   */
  const duplicateSelection = (): boolean => {
    if (primaryId === undefined) return false
    const current = canvasRef.current
    const fragment = extractClipboardFragment(current, new Set([primaryId, ...extraIds]))
    const command = buildFragmentInsertCommand(
      current,
      fragment,
      () => createId?.() ?? crypto.randomUUID(),
    )
    if (command === undefined) return false
    const running = applyCommand(current, command)
    if (running === current) return false
    onChange(running, command)
    const remintedIds =
      command.kind === 'batch'
        ? command.commands.filter((c) => c.kind === 'create-node').map((c) => c.node.id)
        : []
    if (remintedIds.length > 0) selectNodes(remintedIds)
    return true
  }

  /**
   * Copy the selection into the in-app clipboard slot, returning the
   * fragment so the caller can also hand it to the OS clipboard. null
   * when there is nothing to copy.
   */
  const copySelection = (): ClipboardFragment | null => {
    if (primaryId === undefined) return null
    const fragment = extractClipboardFragment(canvasRef.current, new Set([primaryId, ...extraIds]))
    if (fragment.nodes.length === 0) return null
    writeClipboardFragment(fragment)
    // The newest clipboard intent wins: a plain copy lifts a pending cut.
    setPendingCut(null)
    return fragment
  }

  /**
   * Cut-flavoured copy: the fragment also records the cut surface (the
   * edges the deletion is about to sever), so the FIRST same-canvas paste
   * reconnects them — a cut is the front half of a move, not a delete.
   */
  const cutSelection = (): ClipboardFragment | null => {
    if (primaryId === undefined) return null
    const fragment = extractClipboardFragment(
      canvasRef.current,
      new Set([primaryId, ...extraIds]),
      {
        cutId: crypto.randomUUID(),
      },
    )
    if (fragment.nodes.length === 0 || fragment.cut === undefined) return null
    writeClipboardFragment(fragment)
    // Defer the delete: hold the originals as a ghost until the paste
    // decides what the cut meant (move here, copy elsewhere, or nothing).
    setPendingCut({
      cutId: fragment.cut.id,
      snapshot: new Map(fragment.nodes.map((node) => [node.id, JSON.stringify(node)])),
    })
    return fragment
  }

  /** A note carrying pasted foreign text, at the viewport center. */
  const createTextNodeAtViewportCenter = (text: string): void => {
    const point = screenToCanvas(viewportCenterScreen(), viewport)
    const node = textNodeDefaults(createId?.() ?? crypto.randomUUID(), point, text)
    const command: EditorCommand = { kind: 'create-node', node }
    const running = applyCommand(canvasRef.current, command)
    if (running === canvasRef.current) return
    onChange(running, command)
    selectNodes([node.id])
  }

  /**
   * Paste the stored fragment as ONE batch: reminted ids, edges remapped.
   * With an anchor point (the empty-space menu's "Paste here") the
   * fragment's bounding box centers on it; without one (Cmd+V) copies
   * land +16px from their source coordinates, cascading like duplicate.
   */
  const pasteClipboard = (at?: Point): boolean => {
    const fragment = readClipboardFragment()
    if (fragment === null) return false
    return pasteFragment(fragment, at)
  }

  /** Paste an explicit fragment (in-app slot, or one parsed off the OS clipboard). */
  const pasteFragment = (
    fragment: Pick<ClipboardFragment, 'nodes' | 'edges' | 'cut'>,
    at?: Point,
  ): boolean => {
    const current = canvasRef.current
    // A paste that answers THIS canvas's pending cut is a MOVE: the held
    // nodes keep their ids and just change place, so every edge — internal
    // or boundary — survives without any reconnection machinery. One batch
    // of move-node commands = one undo step that only moves them back.
    if (fragment.cut !== undefined && pendingCut?.cutId === fragment.cut.id) {
      const held = current.nodes.filter((node) => pendingCut.snapshot.has(node.id))
      if (held.length > 0) {
        let dx = DUPLICATE_OFFSET_PX
        let dy = DUPLICATE_OFFSET_PX
        if (at !== undefined) {
          const minX = Math.min(...held.map((node) => node.x))
          const minY = Math.min(...held.map((node) => node.y))
          const maxX = Math.max(...held.map((node) => node.x + node.width))
          const maxY = Math.max(...held.map((node) => node.y + node.height))
          dx = Math.round(at.x - (minX + maxX) / 2)
          dy = Math.round(at.y - (minY + maxY) / 2)
        }
        const moveCommand: EditorCommand = {
          kind: 'batch',
          commands: held.map((node) => ({
            kind: 'move-node' as const,
            id: node.id,
            x: node.x + dx,
            y: node.y + dy,
          })),
        }
        setPendingCut(null)
        const running = applyCommand(current, moveCommand)
        if (running === current) return false
        onChange(running, moveCommand)
        selectNodes(held.map((node) => node.id))
        return true
      }
    }
    // The cut surface reconnects while the document shows no trace of a
    // previous reconnection: as long as any edge a prior paste of this cut
    // created is still on THIS canvas, the fragment behaves as a plain
    // copy (no second wire onto the peer). Undo removes those edges, so
    // the next paste is a first paste again.
    const cut =
      fragment.cut !== undefined &&
      !recordedReconnection(fragment.cut.id).some((id) =>
        current.edges.some((edge) => edge.id === id),
      )
        ? fragment.cut
        : undefined
    const command = buildFragmentInsertCommand(
      current,
      { nodes: fragment.nodes, edges: fragment.edges, cut },
      () => createId?.() ?? crypto.randomUUID(),
      at,
    )
    if (command === undefined) return false
    const running = applyCommand(current, command)
    if (running === current) return false
    if (cut !== undefined && command.kind === 'batch') {
      // The boundary edges are the created edges with an endpoint OUTSIDE
      // the created node set — that endpoint is the surviving peer.
      const createdNodeIds = new Set(
        command.commands.flatMap((c) => (c.kind === 'create-node' ? [c.node.id] : [])),
      )
      recordReconnection(
        cut.id,
        command.commands.flatMap((c) =>
          c.kind === 'create-edge' &&
          (!createdNodeIds.has(c.edge.fromNode) || !createdNodeIds.has(c.edge.toNode))
            ? [c.edge.id]
            : [],
        ),
      )
    }
    onChange(running, command)
    const remintedIds =
      command.kind === 'batch'
        ? command.commands.filter((c) => c.kind === 'create-node').map((c) => c.node.id)
        : []
    if (remintedIds.length > 0) selectNodes(remintedIds)
    return true
  }

  return {
    duplicateSelection,
    copySelection,
    cutSelection,
    createTextNodeAtViewportCenter,
    pasteClipboard,
    pasteFragment,
  }
}
