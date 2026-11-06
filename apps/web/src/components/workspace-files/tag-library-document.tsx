import { TAG_LIBRARY_PATH } from '@kamiazya/whiteboard-plugin-visual'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'

/**
 * Whether `entry` is the workspace's stored tag library — the note at `tags`
 * whose facets hold the colours tags are drawn in. Setting a colour makes it,
 * so it turns up in the list as a note nobody wrote, reading as empty, and a
 * tidy person deletes it and the colours with it.
 *
 * Labelled rather than hidden: a note someone wrote at `tags` IS the library
 * too, and hiding it would hide their writing; the keepers and MCP read and
 * write it at that path either way.
 */
export function isTagLibrary(entry: Pick<WorkspaceDocumentEntry, 'path'>): boolean {
  return entry.path === TAG_LIBRARY_PATH
}

/** What the library's own place says it keeps, where an ordinary empty note says it is empty. */
export const TAG_LIBRARY_KEEPS =
  "This note keeps this workspace's tag colours, which every board's legend reads. Deleting it removes them."

/** The label a list draws beside the library's name. */
export function TagLibraryBadge({ id }: { readonly id?: string }) {
  return (
    <span
      id={id}
      data-testid="tag-library-badge"
      className="bg-muted text-muted-foreground shrink-0 self-start rounded px-1 text-[10px] font-medium"
    >
      Tag library
    </span>
  )
}
