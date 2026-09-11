import {
  documentContainers,
  MARKDOWN_BODY_KEY,
  resolveWorkspaceDocumentById,
  setWorkspaceDocumentName,
} from '@kamiazya/whiteboard-loro-adapter'
import type { Loro } from 'loro-crdt'
import { isGeneratedDocumentPath } from '../components/workspace-files/new-document-path.js'
import { titleFromMarkdownBody } from '../lib/title-from-body.js'

/**
 * Names a document after the title its body announces, while nobody has
 * named it and nobody has placed it.
 *
 * Someone who opens a note and types `# Weekly review` has said what it is
 * called. Without this the workspace keeps calling it `untitled`, in the
 * card, the URL and every search result, and the only way to fix that is to
 * type the same words a second time into the rename dialog.
 *
 * Two gates, and the second is the load-bearing one. `name` absent means
 * "nobody named it" — but it is ALSO what the rename dialog leaves behind
 * when someone deliberately clears a name to show the path instead, and
 * re-seeding over that would be this codebase's recurring defect: state
 * keyed on something that has since changed. A still-generated path is the
 * proxy that separates them, since anyone who cleared a name on a document
 * they had also placed has engaged with naming.
 *
 * The PATH is never touched. ADR-0008 measured deriving one from a display
 * name and found every non-Latin title collapsing to `untitled-N`; ADR-0007's
 * addendum retracted it. Seeding the name leaves the address alone, so a
 * heading edit can never move a document out from under a link.
 *
 * Runs on every save, and KEEPS UP with a heading still being typed. Typing
 * outlasts the 500ms debounce on a loaded machine, so a save lands while the
 * title is half written — and a first version of this stopped there, because
 * a name being present was what closed its gate. Measured in a real browser:
 * `# From` … ` the list` produced a document called "From", forever. A wrong
 * name is worse than `untitled`, because it looks deliberate.
 *
 * So a name this function produced may be replaced, and the test for "this
 * one is ours" is that the title still STARTS WITH it — which is exactly the
 * shape a half-typed heading leaves behind. Any other name is a person's, and
 * is never touched: rename to "Meeting" over a body reading `# From the list`
 * and the seeding is finished with this document.
 */
export function seedNameFromTitle(workspace: Loro, documentId: string): void {
  const entry = resolveWorkspaceDocumentById(workspace, documentId)
  if (entry === null) return
  if (!isGeneratedDocumentPath(entry.path)) return
  const title = titleFromMarkdownBody(
    documentContainers(workspace, documentId).getText(MARKDOWN_BODY_KEY).toString(),
  )
  if (title === undefined || title === entry.name) return
  // Absent: nobody has named it. A strict prefix of the title: we named it,
  // from a heading that has since grown.
  const ours = entry.name === undefined || title.startsWith(entry.name)
  if (!ours) return
  setWorkspaceDocumentName(workspace, { documentId, name: title })
}
