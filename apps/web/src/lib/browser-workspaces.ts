/**
 * The browser keeper's half of the shell switcher's source.
 *
 * Separate from the shell so the shell never learns where a keeper stores
 * its workspaces, and separate from `create-browser-workspace.ts` so the
 * registry access is in one place rather than constructed at each call site.
 *
 * `IdbDocumentIndex` rather than the folding index: folding is about
 * DOCUMENTS written by older builds, and a workspace registry row has
 * nothing to fold. Taking the folding one would pull loro-crdt behind a
 * control that renders in the app shell.
 */
import type { RenameWorkspaceInput, WorkspaceEntry } from '@kamiazya/whiteboard-ports'
import { createBrowserWorkspace } from './create-browser-workspace.js'
import { IdbDocumentIndex } from './idb-document-index.js'

const index = new IdbDocumentIndex()

export function listBrowserWorkspaces(): Promise<WorkspaceEntry[]> {
  return index.listWorkspaces()
}

export function createBrowserWorkspaceNamed(displayName: string): Promise<WorkspaceEntry> {
  return createBrowserWorkspace(index, { displayName })
}

/**
 * Renames the workspace the browser keeps, and answers what it now is.
 *
 * Takes the canonical id rather than a handle for the reason the switcher's
 * own contract states: the address is what may be moving, so it cannot also
 * be how the subject is named.
 */
export function renameBrowserWorkspace(
  workspaceId: string,
  input: Omit<RenameWorkspaceInput, 'workspaceId'>,
): Promise<WorkspaceEntry> {
  return index.renameWorkspace({ workspaceId, ...input })
}
