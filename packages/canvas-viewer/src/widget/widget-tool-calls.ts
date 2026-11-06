// The widget's outbound `tools/call` requests, built in ONE place.
//
// The widget cannot import server-core (its dependency direction forbids it),
// so a literal written inline in widget-entry.ts is checked by nothing the
// compiler sees: a field the server's schema later requires would pass every
// widget test and be refused at runtime. Keeping the builders free of imports
// lets the other end — mcp-server's test and its e2e smoke — import the very
// bytes the widget sends and run them through the server's own input schema.
// Only type imports, which leave no runtime import behind.

import type { SpatialRenderStyle } from '@kamiazya/whiteboard-canvas-render'

export type CommentAnchor = { x: number; y: number; targetNodeId?: string }

/**
 * `style` is the look the last result was drawn under. `canvas_view` echoes
 * the style it was asked for and defaults to the bundled one, so a refresh that
 * leaves it out would redraw a themed canvas clean.
 */
export function canvasViewCall(target: {
  workspaceId: string
  documentId: string
  style?: SpatialRenderStyle
}) {
  return {
    name: 'canvas_view' as const,
    arguments: {
      workspaceId: target.workspaceId,
      documentId: target.documentId,
      ...(target.style === undefined ? {} : { style: target.style }),
    },
  }
}

/**
 * A comment from the widget's box, opened as a thread on the document's
 * annotation layer (ADR-0026 decision 6). The click's point is the anchor; a
 * click inside a node names it too, so the pin follows that node.
 */
export function threadAddCall(
  target: { workspaceId: string; documentId: string },
  anchor: CommentAnchor,
  text: string,
) {
  return {
    name: 'wb_thread_edit' as const,
    arguments: {
      workspaceId: target.workspaceId,
      documentId: target.documentId,
      ops: [
        {
          op: 'thread.add' as const,
          anchor: {
            kind: 'spatial' as const,
            x: anchor.x,
            y: anchor.y,
            ...(anchor.targetNodeId === undefined ? {} : { nodeId: anchor.targetNodeId }),
          },
          body: text,
        },
      ],
    },
  }
}
