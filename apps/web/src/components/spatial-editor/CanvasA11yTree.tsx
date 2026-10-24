import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { useEffect, useMemo, useRef } from 'react'
import { announceOnCanvas } from '../../lib/canvas-announcer.js'
import { readingOrder } from '../../lib/spatial/reading-order.js'
import { canvasChangeMessage, selectionMessage } from './canvas-announcement-text.js'
import { edgeA11yName, nodeA11yName } from './node-a11y-name.js'

/** The id of the option standing for a node or an edge, under one canvas's prefix. */
function a11yItemId(prefix: string, kind: 'node' | 'edge', id: string): string {
  return `${prefix}-${kind}-${id}`
}

/** The option the canvas root's focus should read as being on, if anything is selected. */
export function activeDescendantId(
  prefix: string,
  primaryId: string | null,
  selectedEdgeId: string | null,
): string | undefined {
  if (primaryId !== null) return a11yItemId(prefix, 'node', primaryId)
  if (selectedEdgeId !== null) return a11yItemId(prefix, 'edge', selectedEdgeId)
  return undefined
}

/**
 * Says the result of what just happened: a creation, a deletion, a
 * connection, a grouping, or — when the canvas itself did not change — what
 * the selection moved to. One message per commit, the canvas change winning,
 * since creating a node also selects it.
 */
function useCanvasAnnouncements(
  canvas: SpatialCanvas,
  selectedNodeIds: readonly string[],
  selectedEdgeId: string | null,
  externalVersion: number | undefined,
): void {
  const selectionKey = `${selectedNodeIds.join('\u0000')}\u0001${selectedEdgeId ?? ''}`
  const previous = useRef({ canvas, selectionKey, externalVersion })
  useEffect(() => {
    const before = previous.current
    previous.current = { canvas, selectionKey, externalVersion }
    // A document arriving from outside (opened, synced) onto an empty board is
    // a load, not something the person just added.
    const loaded = before.externalVersion !== externalVersion && before.canvas.nodes.length === 0
    const changed =
      before.canvas === canvas || loaded ? undefined : canvasChangeMessage(before.canvas, canvas)
    const selected =
      before.selectionKey === selectionKey
        ? undefined
        : selectionMessage(canvas, selectedNodeIds, selectedEdgeId)
    const message = changed ?? selected
    if (message !== undefined) announceOnCanvas(message)
  }, [canvas, selectionKey, selectedNodeIds, selectedEdgeId, externalVersion])
}

function A11yOption({
  id,
  name,
  selected,
}: {
  readonly id: string
  readonly name: string
  readonly selected: boolean
}) {
  return <div role="option" tabIndex={-1} id={id} aria-label={name} aria-selected={selected} />
}

/**
 * The canvas is drawn, so the accessibility tree has nothing to say about
 * its contents. This is the parallel projection: every node and edge as a
 * named, selectable option, in the order Tab walks them, off-screen. Focus
 * stays on the canvas root, which points at the selected option with
 * `aria-activedescendant` — the same virtual-focus arrangement a listbox uses.
 */
export function CanvasA11yTree({
  canvas,
  idPrefix,
  primaryId,
  extraIds,
  selectedEdgeId,
  externalVersion,
}: {
  readonly canvas: SpatialCanvas
  /** The editor's external-replacement counter; a bump marks the canvas as arriving rather than edited. */
  readonly externalVersion?: number | undefined
  readonly idPrefix: string
  readonly primaryId: string | null
  readonly extraIds: ReadonlySet<string>
  readonly selectedEdgeId: string | null
}) {
  const selectedNodeIds = useMemo(
    () => (primaryId === null ? [] : [primaryId, ...extraIds]),
    [primaryId, extraIds],
  )
  useCanvasAnnouncements(canvas, selectedNodeIds, selectedEdgeId, externalVersion)
  const nodes = useMemo(() => readingOrder(canvas.nodes), [canvas.nodes])
  const selectedSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds])
  return (
    // Not a Tab stop and not a pointer target: the root keeps both jobs.
    <div
      role="listbox"
      aria-label="Canvas contents"
      aria-multiselectable="true"
      className="sr-only pointer-events-none"
    >
      {nodes.map((node) => (
        <A11yOption
          key={node.id}
          id={a11yItemId(idPrefix, 'node', node.id)}
          name={nodeA11yName(node)}
          selected={selectedSet.has(node.id)}
        />
      ))}
      {canvas.edges.map((edge) => (
        <A11yOption
          key={edge.id}
          id={a11yItemId(idPrefix, 'edge', edge.id)}
          name={edgeA11yName(edge, canvas.nodes)}
          selected={edge.id === selectedEdgeId}
        />
      ))}
    </div>
  )
}
