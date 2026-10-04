/**
 * The workspace section of the mark's popover: which one you are in, the
 * others you can go to, and the two ways to change what a workspace is
 * called.
 *
 * Content only — no trigger and no popover of its own. The mark IS the
 * switcher ("Mark as Switcher"), so a second trigger beside it would be the
 * same subject twice, and the shell's own rule is that the row carries one
 * carrier. What names the workspace on screen is the popover's head, which
 * `AppShell` composes beside the session word; the row itself stays
 * `[mark] ALPHA <spacer> gear`.
 */

import { messageOf } from '@kamiazya/whiteboard-model'
import type { WorkspaceEntry } from '@kamiazya/whiteboard-ports'
import { useEffect, useId, useRef, useState } from 'react'
import { isImeComposingKeydown } from '../../lib/ime-keydown.js'
import { workspaceHandle, workspaceLabel } from '../../lib/workspace-handle.js'
import type { WorkspaceRow, WorkspaceSwitcherSource } from '../../lib/workspace-switcher-source.js'
import { WorkspaceIdentityFields } from './WorkspaceIdentityFields.js'

export interface WorkspaceMenuProps {
  /**
   * The handle the address currently carries, or `null` when it carries none
   * — a daemon holding no workspaces yet serves `/`. With no current handle
   * no row is marked and the rename section does not render, which is right:
   * there is nothing to rename, and creation is what the reader needs.
   */
  readonly current: string | null
  /** The rows, loaded by the shell so its head can name the current one. */
  readonly workspaces: readonly WorkspaceRow[]
  readonly source: WorkspaceSwitcherSource
  readonly onSwitch: (handle: string) => void
  /** Replaces a row in the shell's copy after a rename answers. */
  readonly onRenamed: (entry: WorkspaceEntry) => void
  /** The session word, shown beside the name. `null` where no page holds one. */
  readonly sessionLabel?: string | null
  /**
   * Hands the shell what `source.counts()` answered, so the counts live
   * beside the rows they belong to rather than in this component. Closing
   * the popover unmounts this; the shell keeps them, and the next open is
   * free.
   */
  readonly onCounted?: (counts: ReadonlyMap<string, number>) => void
}

export function WorkspaceMenu({
  current,
  workspaces,
  source,
  onSwitch,
  onRenamed,
  sessionLabel,
  onCounted,
}: WorkspaceMenuProps) {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const newNameRef = useRef<HTMLInputElement>(null)
  const nameId = useId()
  // A ref, not the `busy` state below, and the difference is the whole guard.
  // `busy` is a React SNAPSHOT: a second submit that runs before React
  // re-renders still sees it false. Measured — two keydowns dispatched inside
  // one batch call `create` twice; the same two through `fireEvent`, which
  // flushes between them, call it once. Each browser create MINTS and
  // persists a workspace.
  const submitting = useRef(false)

  const active = workspaces.find((w) => workspaceHandle(w) === current)
  const create = source.create
  const rename = active === undefined ? undefined : source.rename

  useEffect(() => {
    if (creating) newNameRef.current?.focus()
  }, [creating])

  // Held in a ref so the effect below depends on the FACT of counting rather
  // than on the identity of a callback the shell writes inline. Depending on
  // the function itself re-runs the effect on every shell render, and the
  // shell re-renders as a direct result of what this effect reports.
  const countedRef = useRef(onCounted)
  countedRef.current = onCounted
  // One ask per mount. Radix unmounts this content when the popover closes,
  // so mounting IS the open, and re-opening while counts are still missing
  // is a deliberate retry rather than a loop.
  const asked = useRef(false)
  useEffect(() => {
    const counts = source.counts
    if (counts === undefined || asked.current) return
    // Rows that already carry a count are the second open, or a keeper that
    // counted in `list()`. Either way there is nothing to buy.
    if (!workspaces.some((w) => w.documentCount === undefined)) return
    asked.current = true
    counts()
      .then((counted) => countedRef.current?.(counted))
      // A count is an ornament on a row whose job is switching. The rows
      // stay exactly as readable without it, so a failure here is silent by
      // design — the alternative is an error banner over a working list.
      .catch(() => {})
  }, [source, workspaces])

  const failed = (cause: unknown, fallback: string) => {
    submitting.current = false
    setError(messageOf(cause, fallback))
    setBusy(false)
  }

  const submitCreate = () => {
    const displayName = newName.trim()
    if (create === undefined || displayName === '' || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    create(displayName)
      .then((created) => {
        // Released on SUCCESS too, not only on failure. `onSwitch` is an
        // in-SPA route change for the browser keeper, so the shell does not
        // remount and this instance survives the navigation — holding the
        // guard would leave the form open with Create disabled until the
        // popover happened to be closed and reopened.
        submitting.current = false
        setBusy(false)
        setCreating(false)
        // The handle CREATE answered with, never the name that was typed: a
        // segment is derived from the name and may be suffixed past a
        // collision, or absent entirely, in which case the address is the
        // canonical id. Navigating to what was typed addresses nothing.
        onSwitch(workspaceHandle(created))
      })
      .catch((cause: unknown) => failed(cause, 'Could not create the workspace.'))
  }

  return (
    <>
      {active !== undefined && (
        // The head IS the editor. This repo already retired the pencil-menu
        // rename for a title you edit in place (ADR-0006: an object is
        // "named in place afterwards"), and a `Rename workspace` item here
        // would be that shape rebuilt one layer up. Read-only where the
        // keeper cannot write, never hidden — the name is the head, and
        // hiding the subject to say "you cannot edit it" removes the subject.
        <WorkspaceIdentityFields
          className="mb-2 flex flex-col gap-1 border-b pb-2"
          active={active}
          current={current}
          rename={rename}
          onRenamed={onRenamed}
          onSwitch={onSwitch}
          sessionLabel={sessionLabel}
          notice={error}
        />
      )}
      <p className="px-1 pt-1 pb-0.5 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
        Switch to
      </p>
      <div role="menu" aria-label="Workspaces" className="flex flex-col">
        {workspaces.map((w) => {
          const handle = workspaceHandle(w)
          const isCurrent = handle === current
          return (
            <button
              key={w.workspaceId}
              type="button"
              role="menuitem"
              // `aria-current` rather than a disabled item: the current
              // workspace belongs in the list (it is what tells a reader
              // which one they are on), and a disabled control announces
              // "unavailable", which is the wrong story about the place you
              // already are.
              {...(isCurrent ? { 'aria-current': 'true' } : {})}
              onClick={() => {
                if (!isCurrent) onSwitch(handle)
              }}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent aria-[current]:font-semibold"
            >
              <span aria-hidden="true" className="w-3.5 shrink-0 text-muted-foreground">
                {isCurrent ? '\u2713' : ''}
              </span>
              <span className="truncate">{workspaceLabel(w)}</span>
              {/* Reads as part of the row's own sentence rather than as a
                  separate column, so a keeper that does not count leaves no
                  hole where a number would be. `0` is rendered like any other
                  count — the check is against undefined, not against
                  falsiness, which would silently hide every empty
                  workspace. */}
              {w.documentCount !== undefined && (
                <span className="ml-auto shrink-0 pl-2 text-xs font-normal text-muted-foreground tabular-nums">
                  {w.documentCount}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {create !== undefined && (
        <div className="mt-1 border-t pt-1">
          {creating ? (
            <div className="flex flex-col gap-1.5 p-1">
              <label htmlFor={`${nameId}-new`} className="text-xs text-muted-foreground">
                New workspace name
              </label>
              <input
                id={`${nameId}-new`}
                enterKeyHint="done"
                ref={newNameRef}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || isImeComposingKeydown(event.nativeEvent)) return
                  submitCreate()
                }}
                className="rounded-md border bg-background px-2 py-1 text-sm"
              />
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={busy || newName.trim() === ''}
                  onClick={submitCreate}
                  className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false)
                    setError(null)
                  }}
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div role="menu" aria-label="Workspace actions" className="flex flex-col">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setNewName('')
                  setCreating(true)
                }}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
              >
                <span aria-hidden="true" className="w-3.5 shrink-0 text-muted-foreground">
                  ＋
                </span>
                New workspace
              </button>
            </div>
          )}
        </div>
      )}
    </>
  )
}
