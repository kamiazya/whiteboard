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

import type { RenameWorkspaceInput, WorkspaceEntry } from '@kamiazya/whiteboard-ports'
import { useEffect, useId, useRef, useState } from 'react'
import { workspaceHandle, workspaceLabel } from '@/lib/workspace-handle'

/**
 * Where the workspaces come from and how one is made or renamed — the half
 * that differs between the keepers (IndexedDB here, HTTP there).
 *
 * Hold it stable across renders (`useMemo` at the call site): the list is
 * read in an effect keyed on this object, so a fresh one per render is a
 * fetch per render.
 */
/**
 * A workspace as the switcher needs it: its identity, plus how much is in it.
 *
 * `documentCount` is optional and absent is NOT zero — zero says the
 * workspace is empty, which is exactly the row a person needs to recognise,
 * while absent says this keeper did not count. The browser keeper is the
 * absent case today: documents live in the workspace tree, so counting them
 * means loading loro-crdt behind a control that renders in the app shell,
 * which `browser-workspaces.ts` deliberately avoids.
 */
export type WorkspaceRow = WorkspaceEntry & { readonly documentCount?: number }

export interface WorkspaceSwitcherSource {
  list(): Promise<readonly WorkspaceRow[]>
  /**
   * Answers the workspace that was created — including the handle it was
   * actually given.
   *
   * OPTIONAL, because a keeper can genuinely have no way to create one: the
   * daemon publishes `GET /api/workspaces` and nothing that writes. Absent
   * here means the menu offers no creation at all, which is DESIGN.md's
   * standing rule — never offer what the keeper cannot honour — rather than
   * a disabled button, which would say "not right now" about something that
   * is not there.
   */
  create?(displayName: string): Promise<WorkspaceEntry>
  /**
   * Changes the two layers ADR-0019 lets a workspace's owner choose, and
   * answers the workspace as it now stands. Optional on the same rule as
   * `create`.
   *
   * Takes the canonical `workspaceId`, never the handle — the segment is
   * precisely what may be about to change, and naming the subject by the
   * thing being moved is how a rename addresses the wrong workspace.
   */
  rename?(
    workspaceId: string,
    input: Omit<RenameWorkspaceInput, 'workspaceId'>,
  ): Promise<WorkspaceEntry>
}

export interface WorkspaceMenuProps {
  /** The handle the address currently carries. */
  readonly current: string
  /** The rows, loaded by the shell so its head can name the current one. */
  readonly workspaces: readonly WorkspaceRow[]
  readonly source: WorkspaceSwitcherSource
  readonly onSwitch: (handle: string) => void
  /** Replaces a row in the shell's copy after a rename answers. */
  readonly onRenamed: (entry: WorkspaceEntry) => void
  /** The session word, shown beside the name. `null` where no page holds one. */
  readonly sessionLabel?: string | null
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

/**
 * Each layer is written on its OWN, never as a form submitting both. Sending
 * an unchanged segment back would turn every name edit into a segment write,
 * and the segment write is the one that can be refused for a collision.
 *
 * An emptied field writes nothing rather than clearing: the port has no way
 * to clear a layer, and a workspace without one is a state it arrives in,
 * not one to offer as an edit.
 */
type RenamedLayers = Omit<RenameWorkspaceInput, 'workspaceId'>

function unchanged(next: string, current: string | undefined): boolean {
  const trimmed = next.trim()
  return trimmed === '' || trimmed === current
}

export function WorkspaceMenu({
  current,
  workspaces,
  source,
  onSwitch,
  onRenamed,
  sessionLabel,
}: WorkspaceMenuProps) {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const newNameRef = useRef<HTMLInputElement>(null)
  const nameId = useId()
  const urlId = useId()
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

  // Null means "not being edited", so the box shows the stored value. While
  // it is a string the box shows THAT, because a committed name comes back
  // normalised and re-rendering the normalised form on the keystroke that
  // typed a space erases it — "Design team" typed one key at a time would
  // arrive as "Designteam". Same reason `DocumentProperties` holds a draft.
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  // The URL's draft is not the same device. It is the PENDING edit: this
  // field does not commit per keystroke, so the draft is what has not been
  // written yet rather than a rendering workaround.
  const [urlDraft, setUrlDraft] = useState<string | null>(null)
  // What the name held when the current edit began. Every keystroke is
  // already committed, so Escape has nothing to discard — it has to put the
  // previous name BACK, or "type, change your mind, Escape" silently keeps
  // the half-typed one.
  const nameBaseline = useRef(active?.displayName ?? '')

  useEffect(() => {
    if (creating) newNameRef.current?.focus()
  }, [creating])

  const failed = (cause: unknown, fallback: string) => {
    submitting.current = false
    setError(messageOf(cause, fallback))
    setBusy(false)
  }

  const write = (input: RenamedLayers) => {
    if (rename === undefined || active === undefined) return
    setError(null)
    rename(active.workspaceId, input)
      .then((renamed) => {
        // Taken from what rename ANSWERED rather than re-listed: a name edit
        // navigates nowhere and remounts nothing, so the shell's own copy of
        // the row is the only thing that can restate the head.
        onRenamed(renamed)
        // Only when the SEGMENT moved. The old handle stops answering the
        // moment it changes, so a page left on it addresses a workspace that
        // is no longer there.
        const moved = workspaceHandle(renamed)
        if (moved !== current) onSwitch(moved)
      })
      .catch((cause: unknown) => setError(messageOf(cause, 'Could not rename the workspace.')))
  }

  const commitUrl = () => {
    if (urlDraft === null) return
    const next = urlDraft
    setUrlDraft(null)
    if (unchanged(next, active?.segment)) return
    write({ segment: next.trim() })
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
        <div className="mb-2 flex flex-col gap-1 border-b pb-2">
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor={nameId}>
              Workspace name
            </label>
            <input
              id={nameId}
              value={nameDraft ?? active.displayName ?? ''}
              readOnly={rename === undefined}
              placeholder="Unnamed workspace"
              onFocus={() => {
                nameBaseline.current = active.displayName ?? ''
              }}
              onChange={(event) => {
                if (rename === undefined) return
                setNameDraft(event.target.value)
                if (unchanged(event.target.value, active.displayName)) return
                write({ displayName: event.target.value.trim() })
              }}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key !== 'Escape' || rename === undefined) return
                event.preventDefault()
                const shown = nameDraft ?? active.displayName ?? ''
                setNameDraft(null)
                // Compared against what the BOX holds, never against the
                // stored name: the commit is async, so the row can still
                // carry the old name here and comparing to it would decide
                // "nothing changed" while a rename is already in flight.
                if (shown !== nameBaseline.current && nameBaseline.current !== '') {
                  write({ displayName: nameBaseline.current })
                }
                event.currentTarget.blur()
              }}
              onBlur={() => setNameDraft(null)}
              className="min-w-0 flex-1 truncate bg-transparent text-sm font-semibold outline-none placeholder:font-normal placeholder:text-muted-foreground"
            />
            {sessionLabel != null && (
              <span className="shrink-0 text-xs font-medium text-muted-foreground">
                {sessionLabel}
              </span>
            )}
          </div>
          {/* No label names this layer. ADR-0019 calls it the `segment`,
              which is not a word to put in front of somebody, and every
              plainer word invents a FOURTH name for a layer that has three.
              The URL it lands in says the same thing without naming
              anything. */}
          <div className="flex items-center rounded-md border bg-background px-1.5 py-0.5 font-mono text-xs">
            <span aria-hidden="true" className="text-muted-foreground">
              /w/
            </span>
            <label className="sr-only" htmlFor={urlId}>
              Workspace URL
            </label>
            <input
              id={urlId}
              value={urlDraft ?? active.segment ?? ''}
              readOnly={rename === undefined}
              placeholder={active.workspaceId}
              onChange={(event) => {
                if (rename === undefined) return
                setUrlDraft(event.target.value)
              }}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitUrl()
                  return
                }
                if (event.key !== 'Escape') return
                event.preventDefault()
                setUrlDraft(null)
                event.currentTarget.blur()
              }}
              // Committed on blur too: leaving a field having typed in it
              // and losing the edit silently is the worse of the two
              // surprises.
              onBlur={commitUrl}
              className="min-w-0 flex-1 bg-transparent outline-none"
            />
          </div>
          {urlDraft !== null && !unchanged(urlDraft, active.segment) && (
            <p className="text-xs text-muted-foreground">Links using the old URL stop working.</p>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
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
                ref={newNameRef}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submitCreate()
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
