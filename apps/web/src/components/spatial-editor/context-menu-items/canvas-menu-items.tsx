/**
 * The empty-canvas branch: paste-with-fragment, creation entries, the
 * conditional document/image entries, and Tidy at >=2 nodes.
 */
import { tidyNodes } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import {
  ClipboardPaste,
  Eye,
  EyeOff,
  FileBox,
  Frame,
  Image as ImageIcon,
  Link,
  MessageSquarePlus,
  Sparkles,
  StickyNote,
} from 'lucide-react'
import type { MutableRefObject } from 'react'
import { hasClipboardFragment } from '../../../lib/clipboard-store.js'
import type { CanvasCommands } from '../CanvasContextMenu.js'
import type { ContextMenuItem } from '../ContextMenu.js'
import { CREATION_LABELS } from '../creation-labels.js'
import type { FileRefOption } from '../DocumentPickerDialog.js'
import type { Point } from '../viewport.js'

export interface CanvasMenuItemsInput {
  readonly point: Point
  readonly canvas: SpatialCanvas
  readonly canvasRef: MutableRefObject<SpatialCanvas>
  readonly isLocked: (nodeId: string) => boolean
  readonly fileRefOptions?: readonly FileRefOption[]
  readonly onAddImage: CanvasCommands['onAddImage']
  readonly pendingImagePointRef: MutableRefObject<Point | null>
  readonly imageInputRef: MutableRefObject<HTMLInputElement | null>
  readonly pasteClipboard: CanvasCommands['pasteClipboard']
  readonly createNodeAt: CanvasCommands['createNodeAt']
  readonly setLinkDialog: CanvasCommands['setLinkDialog']
  readonly createGroupAtViewportCenter: CanvasCommands['createGroupAtViewportCenter']
  readonly setDocumentPicker: CanvasCommands['setDocumentPicker']
  readonly applyBoxMoves: CanvasCommands['applyBoxMoves']
  readonly setCommentCompose: CanvasCommands['setCommentCompose']
  readonly showResolvedComments: CanvasCommands['showResolvedComments']
  readonly setShowResolvedComments: CanvasCommands['setShowResolvedComments']
}

export function canvasMenuItems({
  point,
  canvas,
  canvasRef,
  isLocked,
  fileRefOptions,
  onAddImage,
  pendingImagePointRef,
  imageInputRef,
  pasteClipboard,
  createNodeAt,
  setLinkDialog,
  createGroupAtViewportCenter,
  setDocumentPicker,
  applyBoxMoves,
  setCommentCompose,
  showResolvedComments,
  setShowResolvedComments,
}: CanvasMenuItemsInput): ContextMenuItem[] {
  // The same creation set as the dock's + menu, anchored at
  // the click point — "here" is exactly the information the
  // bottom dock cannot express.
  const emptyItems: ContextMenuItem[] = [
    ...(hasClipboardFragment()
      ? [
          {
            label: 'Paste here',
            icon: <ClipboardPaste />,
            onSelect: () => {
              pasteClipboard(point)
            },
          },
          { kind: 'separator' } as const,
        ]
      : []),
    {
      label: CREATION_LABELS.note,
      icon: <StickyNote />,
      onSelect: () => createNodeAt(point),
    },
    {
      label: CREATION_LABELS.link,
      icon: <Link />,
      onSelect: () => setLinkDialog({ mode: 'create', point }),
    },
    {
      label: CREATION_LABELS.group,
      icon: <Frame />,
      onSelect: () => createGroupAtViewportCenter(point),
    },
  ]
  if (fileRefOptions !== undefined) {
    emptyItems.push({
      label: CREATION_LABELS.document,
      icon: <FileBox />,
      onSelect: () => setDocumentPicker({ mode: 'create', point }),
    })
  }
  if (onAddImage !== undefined) {
    emptyItems.push({
      label: CREATION_LABELS.image,
      icon: <ImageIcon />,
      onSelect: () => {
        pendingImagePointRef.current = point
        imageInputRef.current?.click()
      },
    })
  }
  // Tidy needs a second node to tidy AGAINST — the item appears
  // only once it can do something, like Align/Distribute above.
  if (canvas.nodes.length >= 2) {
    emptyItems.push({ kind: 'separator' })
    emptyItems.push({
      label: 'Tidy canvas',
      icon: <Sparkles />,
      onSelect: () => applyBoxMoves(tidyNodes(canvasRef.current.nodes, { locked: isLocked })),
    })
  }
  // Its own band: a comment is not content, so it sits apart from the
  // creation set rather than reading as a sixth node kind.
  emptyItems.push({ kind: 'separator' })
  emptyItems.push({
    label: 'Comment here',
    icon: <MessageSquarePlus />,
    onSelect: () => setCommentCompose({ point }),
  })
  // Resolved comments stay in the document; this is the one way to see
  // them again (and reopen one). View state, per user.
  emptyItems.push({
    label: showResolvedComments ? 'Hide resolved comments' : 'Show resolved comments',
    icon: showResolvedComments ? <EyeOff /> : <Eye />,
    onSelect: () => setShowResolvedComments(!showResolvedComments),
  })
  return emptyItems
}
