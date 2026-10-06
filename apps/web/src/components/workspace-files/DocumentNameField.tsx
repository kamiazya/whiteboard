import { DOCUMENT_NAME_MAX_LENGTH } from '@kamiazya/whiteboard-model'
import { documentLabel } from '../../lib/document-label.js'

/**
 * A document's name, as the create and rename forms both ask for it.
 *
 * The name lives in the workspace and may be empty, in which case readers
 * show the path's last segment — so that segment is the placeholder, and the
 * hint says so. One component keeps the two forms from wording the fallback
 * differently.
 */
export function DocumentNameField({
  value,
  path,
  onChange,
}: {
  value: string
  /** The path the field falls back to when left empty. */
  path: string
  onChange: (next: string) => void
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">Name</span>
      <input
        type="text"
        value={value}
        maxLength={DOCUMENT_NAME_MAX_LENGTH}
        onChange={(event) => onChange(event.target.value)}
        placeholder={documentLabel({ path }, 'leaf')}
        className="rounded-md border bg-background px-2 py-1.5 text-sm"
      />
      <span className="text-muted-foreground text-xs">
        What it is called, everywhere it appears. Leave empty to show the last part of the path
        instead.
      </span>
    </label>
  )
}
