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
 * Marked `data-editor-overlay` so the canvas root's gesture handlers ignore
 * presses originating here (see SpatialEditor's isOverlayEvent): without
 * that, the root would capture the pointer and swallow the buttons' clicks.
 */
export type EditorTool = 'select' | 'connect'

interface ToolPaletteProps {
  readonly onCreateNode: () => void
  readonly tool: EditorTool
  readonly onToolChange: (tool: EditorTool) => void
}

const TOOL_BUTTON_CLASS =
  'rounded-md border px-3 py-1.5 text-sm hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-pressed:bg-accent aria-pressed:font-medium'

export function ToolPalette({ onCreateNode, tool, onToolChange }: ToolPaletteProps) {
  return (
    <div
      data-editor-overlay
      data-testid="tool-palette"
      role="toolbar"
      aria-label="Canvas tools"
      className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-lg border bg-background p-1 shadow-md"
    >
      <button
        type="button"
        data-testid="select-tool-button"
        aria-pressed={tool === 'select'}
        onClick={() => onToolChange('select')}
        className={TOOL_BUTTON_CLASS}
      >
        Select
      </button>
      <button
        type="button"
        data-testid="connect-tool-button"
        aria-pressed={tool === 'connect'}
        onClick={() => onToolChange('connect')}
        className={TOOL_BUTTON_CLASS}
      >
        Connect
      </button>
      <button
        type="button"
        data-testid="add-node-button"
        onClick={onCreateNode}
        className="rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        Add note
      </button>
    </div>
  )
}
