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

export function commentAddCall(
  target: { workspaceId: string; documentId: string },
  anchor: CommentAnchor,
  text: string,
) {
  return {
    name: 'wb_canvas_edit' as const,
    arguments: {
      workspaceId: target.workspaceId,
      documentId: target.documentId,
      ops: [
        {
          op: 'comment.add' as const,
          comment: {
            x: anchor.x,
            y: anchor.y,
            ...(anchor.targetNodeId === undefined ? {} : { targetNodeId: anchor.targetNodeId }),
            text,
          },
        },
      ],
    },
  }
}
