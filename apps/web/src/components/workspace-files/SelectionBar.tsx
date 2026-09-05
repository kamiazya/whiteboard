import { Trash2, X } from 'lucide-react'

export interface SelectionBarProps {
  count: number
  onDelete: () => void
  onCancel: () => void
}

/**
 * What a live selection offers: the count, and its one verb.
 *
 * The count is the only text here that a person has to read, and it is the
 * one thing an icon cannot say. Everything else is the card menu's existing
 * icon vocabulary.
 *
 * One verb by decision (owner, 2026-09-05), not by omission: the trash
 * already provides the undo, so a selection mode can be judged on bulk
 * delete alone rather than on a family of bulk actions nobody has asked for.
 */
export function SelectionBar({ count, onDelete, onCancel }: SelectionBarProps) {
  return (
    <div
      data-testid="selection-bar"
      // A live region: the count changes under the person's finger, and on a
      // phone the bar can sit below the card they are tapping.
      role="status"
      className="bg-accent/60 flex items-center gap-2 rounded-md px-2 py-1.5"
    >
      <span className="flex-1 text-sm font-medium">{count} selected</span>
      <button
        type="button"
        onClick={onDelete}
        className="text-destructive hover:bg-destructive/10 flex items-center gap-1 rounded border px-2 py-0.5 text-xs"
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
        Delete
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 rounded border px-2 py-0.5 text-xs"
      >
        <X className="size-3.5" aria-hidden="true" />
        Cancel
      </button>
    </div>
  )
}
