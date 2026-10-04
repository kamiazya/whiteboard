import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { WorkspaceFilesSource } from '../../lib/files-source.js'

export interface WorkspaceFilesPanelProps {
  /**
   * Where the documents live. The panel itself does not know which mode it
   * is in — the daemon and the browser store each supply one of these,
   * which is what lets one browser serve both.
   */
  source: WorkspaceFilesSource
  /**
   * The handle this workspace's URLs carry, when the host knows it.
   *
   * Used only to draw the head of a document's URL in front of the path
   * fields, so a person can see where their text lands. Absent while a page
   * is still resolving its address, and on a host that has no address to
   * give — the fields simply lose the prefix, which is why this is optional
   * rather than something the panel refuses to render without.
   */
  workspace?: string | undefined
  /** Absent means the preview shows no way in — looking still works. */
  onOpenDocument?: (path: string) => void
  /**
   * The folder to open in, and a report of every move away from it.
   *
   * Uncontrolled-with-a-default rather than a controlled `folder` prop: the
   * panel deliberately holds no router (its tests render it bare, and
   * `app-routes.ts` is framework-agnostic on purpose), so the host reads the
   * URL and the panel owns the state. Which means a host must WRITE the
   * address with `replace`, never push — an uncontrolled panel cannot follow
   * a Back that changes only the query string, and a URL the UI silently
   * disagrees with is worse than no folder in the URL at all.
   */
  initialFolder?: string
  onFolderChange?: (folder: string) => void
  /**
   * Copy and ask-to-delete. Both stay with the page: it already owns the
   * duplicate that the grid used and the confirmation dialog that guards a
   * delete, and a second copy of either would be a second set of rules for
   * the same destructive act.
   */
  onDuplicateDocument?: (path: string) => void
  onRequestDelete?: (path: string, displayName: string, kind?: DocumentKind) => void
  /**
   * Delete every one of these paths, behind ONE confirmation.
   *
   * Page-owned for the same reason the single delete is: the confirmation
   * dialog and the store call already live there, and a second copy of
   * either would be a second set of rules for the same destructive act. Its
   * absence is what withholds selection mode — a mode whose only verb
   * cannot fire is a mode with nothing in it.
   */
  onRequestDeleteMany?: (paths: readonly string[]) => void
  /**
   * Any value that changes when the workspace's documents may have changed
   * behind this panel's back.
   *
   * The page performs duplicate and delete on the browser's behalf, and a
   * delete finishes later still, in a confirmation dialog the panel does not
   * own — so neither can be awaited here. Without this the deleted document
   * would stay on screen with a live Delete bound to a path that no longer
   * exists, and a duplicate would never appear at all.
   */
  revision?: unknown
}
