import { messageOf } from '@kamiazya/whiteboard-model'
import { type RefObject, useCallback, useRef, useState } from 'react'
import { z } from 'zod'
import { refuseTakenDocumentName } from '../../lib/display-name-taken.js'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { documentPathTakenMessage } from '../../lib/document-path-taken.js'
import type { WorkspaceFilesSource } from '../../lib/files-source.js'
import type { FolderNames } from '../../lib/folder-names.js'
import { documentLanding, focusLanding } from './folder-landing.js'

/**
 * The rename flow: which document the dialog is open for, whether a submit is
 * in flight, and what refused it.
 *
 * Its own hook because the three states are read by nothing else — the dialog
 * and `submit` are the whole surface — and because a rename is the one write
 * here that applies TWO of them. A path change moves the document (which the
 * caller owns, since a move also decides which folder to show); a name change
 * does not. Either can be refused after the other has landed.
 */
export interface RenameDocument {
  /** The document the dialog is open for, or null when it is closed. */
  readonly renaming: WorkspaceDocumentEntry | null
  readonly busy: boolean
  readonly error: string | null
  /** Opens the dialog on `entry`, clearing whatever refused the last attempt. */
  readonly open: (entry: WorkspaceDocumentEntry) => void
  readonly cancel: () => void
  /**
   * Apply whatever the rename dialog changed: the name through the source's
   * workspace-side setter, the path through the same move the panel already
   * performs. Both, in that order, when both changed — a failed move then
   * leaves the new name applied, which is honest: the dialog stays open on
   * the server's refusal and the field still shows what was typed.
   */
  readonly submit: (
    entry: WorkspaceDocumentEntry,
    name: string | undefined,
    newPath: string,
  ) => Promise<void>
  /**
   * The dialog's close: after a saved rename, focus lands on the renamed
   * document's card. Radix would hand it back to the menu item that opened
   * the dialog, which is gone by then, so it fell to <body>.
   */
  readonly onCloseAutoFocus: (event: Event) => void
}

/**
 * A keeper refuses a name past the bound with the port's own parse, and a
 * ZodError's message is its issue list as JSON — so the issues' own words are
 * what a rename surface shows. A taken address is reworded by the folder's
 * name in `names`; anything else is shown as it stands.
 */
export function refusalMessage(err: unknown, names?: FolderNames): string {
  if (err instanceof z.ZodError) return err.issues.map((issue) => issue.message).join('; ')
  return documentPathTakenMessage(err, names) ?? messageOf(err, 'Could not rename it.')
}

/**
 * Write the name unless a sibling already shows it — judged where the name is
 * written, at the current path and before any move.
 */
async function nameIfFree(
  source: WorkspaceFilesSource,
  listed: readonly WorkspaceDocumentEntry[],
  entry: WorkspaceDocumentEntry,
  name: string | undefined,
): Promise<void> {
  refuseTakenDocumentName(listed, { path: entry.path, name, documentId: entry.documentId })
  await source.setDocumentName(entry, name)
}

interface RenameDocumentDeps {
  readonly source: WorkspaceFilesSource
  /** Moves the document and decides where the panel lands; the caller's. */
  readonly moveDocument: (entry: WorkspaceDocumentEntry, newPath: string) => Promise<void>
  readonly refreshAndSelect: (path: string) => Promise<unknown>
  /** The documents listed now, so a name a sibling already shows is refused before sending. */
  readonly listed: { readonly current: readonly WorkspaceDocumentEntry[] }
  /** The panel, where the renamed document's card is looked for. */
  readonly rootRef: RefObject<HTMLElement | null>
}

export function useRenameDocument({
  source,
  moveDocument,
  refreshAndSelect,
  listed,
  rootRef,
}: RenameDocumentDeps): RenameDocument {
  const [renaming, setRenaming] = useState<WorkspaceDocumentEntry | null>(null)
  const landing = useRef<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = useCallback((entry: WorkspaceDocumentEntry) => {
    setError(null)
    setRenaming(entry)
  }, [])

  // SCOPE RESET — the panel's own scope-reset effect calls this; the marker
  // lets scoped-screen-state.test.ts verify the setters from here.
  const cancel = useCallback(() => {
    setRenaming(null)
    setError(null)
  }, [])

  const submit = useCallback(
    async (entry: WorkspaceDocumentEntry, name: string | undefined, newPath: string) => {
      setBusy(true)
      setError(null)
      try {
        if ((entry.name ?? undefined) !== name) {
          await nameIfFree(source, listed.current, entry, name)
        }
        if (newPath !== entry.path) {
          await moveDocument(entry, newPath)
        } else {
          await refreshAndSelect(entry.path)
        }
        landing.current = newPath
        setRenaming(null)
      } catch (err) {
        // The server names the PRODUCED path that collided, which on a
        // subtree move is often not the one typed here.
        setError(refusalMessage(err))
        // A rename applies two writes; the first may have landed before the
        // second was refused. Re-reading here is what stops the panel from
        // showing a name the store no longer holds — the refusal is about
        // the path, and the rest of the screen must still be true.
        try {
          await refreshAndSelect(entry.path)
        } catch {
          // The list read failing on top of a failed rename leaves what is
          // already on screen; the dialog's own message is the report.
        }
      } finally {
        setBusy(false)
      }
    },
    [source, moveDocument, refreshAndSelect, listed],
  )

  const onCloseAutoFocus = useCallback(
    (event: Event) => {
      const path = landing.current
      landing.current = null
      if (path !== null && focusLanding(rootRef.current, documentLanding(path))) {
        event.preventDefault()
      }
    },
    [rootRef],
  )

  return { renaming, busy, error, open, cancel, submit, onCloseAutoFocus }
}
