import type { FileRefOption } from '../../lib/link-entries.js'
/**
 * Canvas picker — the reference-entry surface for file nodes, used by the
 * palette's Document entry (create) and the context menu's "Change target"
 * (retarget). The host page supplies the options: the editor treats a
 * file reference as an opaque string whose meaning (canvas kept in this browser
 * id, daemon alias path) the composition root owns.
 *
 * Marked `data-editor-overlay` so canvas gestures ignore presses inside
 * it. Positioning is inline for the same reason as the context menu: it
 * must behave identically where the app stylesheet is absent
 * (browser-mode component tests).
 */

export interface DocumentPickerDialogProps {
  readonly title: string
  readonly options: readonly FileRefOption[]
  /** The currently referenced file when retargeting; marked in the list. */
  readonly currentFile?: string
  readonly onPick: (file: string) => void
  readonly onCancel: () => void
}

export function DocumentPickerDialog({
  title,
  options,
  currentFile,
  onPick,
  onCancel,
}: DocumentPickerDialogProps) {
  return (
    <div
      data-editor-overlay
      data-testid="document-picker-dialog"
      role="dialog"
      aria-label={title}
      className="rounded-md border bg-background p-3 shadow-lg"
      style={{
        position: 'absolute',
        zIndex: 30,
        left: '50%',
        top: '35%',
        transform: 'translate(-50%, -50%)',
        width: 'max-content',
        minWidth: 240,
        maxWidth: 360,
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <div className="mb-2 text-xs text-muted-foreground">{title}</div>
      {options.length === 0 ? (
        <div className="px-1 py-2 text-sm text-muted-foreground">No other documents yet.</div>
      ) : (
        <ul className="m-0 flex max-h-64 list-none flex-col gap-0.5 overflow-y-auto p-0">
          {options.map((option) => (
            <li key={option.file}>
              <button
                type="button"
                aria-current={option.file === currentFile}
                onClick={() => onPick(option.file)}
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none aria-[current=true]:bg-accent"
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-1 text-sm text-muted-foreground hover:bg-accent"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
