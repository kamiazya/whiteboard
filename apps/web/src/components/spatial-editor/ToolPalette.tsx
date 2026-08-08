/**
 * Bottom tool palette — the OOUI creation surface.
 *
 * Design rule (recorded in the ooui-palette-vs-object-actions decision):
 * what does NOT exist yet comes from the palette; what already exists is
 * acted on from the object itself (selection affordances, and later a
 * context menu). So this strip carries creation and interaction-mode
 * controls only — it must never grow per-object actions like delete or
 * color, which belong on the selected object.
 *
 * Icon-only buttons (chrome carries no sentence-shaped copy): every button
 * keeps its full accessible name via aria-label — which is also what the
 * existing getByRole('button', { name: ... }) tests and screen readers
 * resolve — and a tooltip supplies the sighted-hover equivalent.
 *
 * Marked `data-editor-overlay` so the canvas root's gesture handlers ignore
 * presses originating here (see SpatialEditor's isOverlayEvent): without
 * that, the root would capture the pointer and swallow the buttons' clicks.
 */
import { FileBox, Frame, Link, MousePointer2, Spline, StickyNote } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export type EditorTool = 'select' | 'connect'

interface ToolPaletteProps {
  readonly onCreateNode: () => void
  readonly onCreateLink: () => void
  readonly onCreateGroup: () => void
  /** Absent when the host supplies no canvas listing — the button hides. */
  readonly onCreateCanvasRef?: () => void
  readonly tool: EditorTool
  readonly onToolChange: (tool: EditorTool) => void
}

const TOOL_BUTTON_CLASS =
  'flex size-9 items-center justify-center rounded-md hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-pressed:bg-accent aria-pressed:text-foreground text-muted-foreground transition-colors duration-(--motion-duration-fast) ease-(--motion-ease-out)'

export function ToolPalette({
  onCreateNode,
  onCreateLink,
  onCreateGroup,
  onCreateCanvasRef,
  tool,
  onToolChange,
}: ToolPaletteProps) {
  return (
    <div
      data-editor-overlay
      data-testid="tool-palette"
      role="toolbar"
      aria-label="Canvas tools"
      className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border bg-background p-1 shadow-md"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid="select-tool-button"
            aria-pressed={tool === 'select'}
            aria-label="Select"
            onClick={() => onToolChange('select')}
            className={TOOL_BUTTON_CLASS}
          >
            <MousePointer2 aria-hidden="true" className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Select</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid="connect-tool-button"
            aria-pressed={tool === 'connect'}
            aria-label="Connect"
            onClick={() => onToolChange('connect')}
            className={TOOL_BUTTON_CLASS}
          >
            <Spline aria-hidden="true" className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Connect nodes</TooltipContent>
      </Tooltip>
      <div aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid="add-node-button"
            aria-label="Add note"
            onClick={onCreateNode}
            className={TOOL_BUTTON_CLASS}
          >
            <StickyNote aria-hidden="true" className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Add note</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid="add-link-button"
            aria-label="Add link"
            onClick={onCreateLink}
            className={TOOL_BUTTON_CLASS}
          >
            <Link aria-hidden="true" className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Add link</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid="add-group-button"
            aria-label="Add group"
            onClick={onCreateGroup}
            className={TOOL_BUTTON_CLASS}
          >
            <Frame aria-hidden="true" className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Add group</TooltipContent>
      </Tooltip>
      {onCreateCanvasRef !== undefined && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid="add-canvas-button"
              aria-label="Add canvas"
              onClick={onCreateCanvasRef}
              className={TOOL_BUTTON_CLASS}
            >
              <FileBox aria-hidden="true" className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Add canvas</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
