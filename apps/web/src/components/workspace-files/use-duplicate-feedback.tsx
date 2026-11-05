import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { documentLabel } from '../../lib/document-label.js'
import { folderOf } from './folder-moves.js'

interface DuplicatedCopy {
  readonly entry: WorkspaceDocumentEntry
  /** What the source is called, which is what the person asked to duplicate. */
  readonly from: string
}

/** Long enough to read the line and reach the button on a phone, like the undo toast. */
const DUPLICATED_WINDOW_MS = 10_000

/** The first document in the asked-about folder that was not listed before. */
function arrivedIn(
  documents: readonly WorkspaceDocumentEntry[],
  before: { readonly ids: ReadonlySet<string>; readonly folder: string },
): WorkspaceDocumentEntry | undefined {
  return documents.find(
    (entry) => !before.ids.has(entry.documentId) && folderOf(entry.path) === before.folder,
  )
}

/** Clears `value` once it has been shown for the window. */
function useExpiry<T>(value: T | null, clear: (next: null) => void) {
  useEffect(() => {
    if (value === null) return
    const timer = setTimeout(() => clear(null), DUPLICATED_WINDOW_MS)
    return () => clearTimeout(timer)
  }, [value, clear])
}

interface DuplicateAsked {
  readonly ids: ReadonlySet<string>
  readonly folder: string
  readonly from: string
  readonly askedAt: number
}

/** Watches each listing for the copy an armed request is waiting on, and selects it. */
function useCopyArrival(
  documents: readonly WorkspaceDocumentEntry[] | null,
  asked: { current: DuplicateAsked | null },
  setCopy: (copy: DuplicatedCopy) => void,
  select: (entry: WorkspaceDocumentEntry) => void,
) {
  useEffect(() => {
    const pending = asked.current
    if (pending === null || documents === null) return
    // The page answers a duplicate with nothing, so one that failed leaves
    // its request armed; past the window, whatever arrives in that folder
    // is somebody else's document, not the copy.
    if (Date.now() - pending.askedAt > DUPLICATED_WINDOW_MS) {
      asked.current = null
      return
    }
    const found = arrivedIn(documents, pending)
    if (found === undefined) return
    asked.current = null
    setCopy({ entry: found, from: pending.from })
    select(found)
    document
      .querySelector(`[data-doc-path="${CSS.escape(found.path)}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [documents, select, asked, setCopy])
}

/**
 * What a Duplicate made, found in the next listing: the first document in the
 * source's folder that was not listed when the duplicate was asked for. The
 * page owns the write and answers nothing, so the copy is recognised by
 * having arrived rather than by a path the page would have to hand back.
 *
 * The copy is selected and scrolled to, because "Name (copy)" appearing
 * somewhere in a long folder was otherwise the only sign anything happened.
 */
export function useDuplicateFeedback({
  documents,
  onDuplicateDocument,
  select,
}: {
  documents: readonly WorkspaceDocumentEntry[] | null
  onDuplicateDocument: ((path: string) => void) | undefined
  select: (entry: WorkspaceDocumentEntry) => void
}) {
  const asked = useRef<DuplicateAsked | null>(null)
  const [copy, setCopy] = useState<DuplicatedCopy | null>(null)
  useCopyArrival(documents, asked, setCopy, select)
  useExpiry(copy, setCopy)

  const listed = useRef(documents)
  listed.current = documents
  const duplicate = useCallback(
    (path: string) => {
      const rows = listed.current ?? []
      const source = rows.find((entry) => entry.path === path)
      asked.current = {
        ids: new Set(rows.map((entry) => entry.documentId)),
        folder: folderOf(path),
        from: source === undefined ? path : documentLabel(source, 'leaf'),
        askedAt: Date.now(),
      }
      onDuplicateDocument?.(path)
    },
    [onDuplicateDocument],
  )

  const dismiss = useCallback(() => setCopy(null), [])
  return { duplicate: onDuplicateDocument === undefined ? undefined : duplicate, copy, dismiss }
}

/** "Duplicated <name> — Open", floating over the list until it times out or is used. */
export function DuplicatedToast({
  copy,
  onOpen,
}: {
  copy: DuplicatedCopy | null
  /** Absent on a host that cannot open a document: the line still says what happened. */
  onOpen: ((entry: WorkspaceDocumentEntry) => void) | undefined
}) {
  if (copy === null) return null
  return (
    <div className="fixed bottom-4 left-1/2 z-50 max-w-[calc(100%-2rem)] -translate-x-1/2">
      <div
        role="status"
        aria-live="polite"
        className="bg-background animate-in fade-in-0 slide-in-from-bottom-2 flex items-center gap-3 rounded-lg border px-4 py-2 text-sm shadow-lg duration-(--motion-duration-normal) ease-(--motion-ease-out)"
      >
        <span className="min-w-0 truncate">Duplicated {copy.from}</span>
        {onOpen !== undefined && (
          <button
            type="button"
            onClick={() => onOpen(copy.entry)}
            className="hover:bg-accent rounded-md border px-2 py-0.5 font-medium pointer-coarse:min-h-11 pointer-coarse:px-3"
          >
            Open
          </button>
        )}
      </div>
    </div>
  )
}
