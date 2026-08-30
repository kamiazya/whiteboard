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

import type { WorkspaceEntry } from '@kamiazya/whiteboard-ports'
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
export interface WorkspaceSwitcherSource {
  list(): Promise<readonly WorkspaceEntry[]>
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
    input: { segment?: string; displayName?: string },
  ): Promise<WorkspaceEntry>
}

export interface WorkspaceMenuProps {
  /** The handle the address currently carries. */
  readonly current: string
  /** The rows, loaded by the shell so its head can name the current one. */
  readonly workspaces: readonly WorkspaceEntry[]
  readonly source: WorkspaceSwitcherSource
  readonly onSwitch: (handle: string) => void
  /** Replaces a row in the shell's copy after a rename answers. */
  readonly onRenamed: (entry: WorkspaceEntry) => void
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

/**
 * The layers this form actually CHANGED, in the port's own shape — absent
 * meaning "leave it alone".
 *
 * Submitting every field back would turn a display-name edit into a segment
 * write, and the segment write is the one that can be refused for a
 * collision. An emptied segment field is absent rather than a clear: the
 * port has no way to clear a layer, and a workspace without one is a state
 * it arrives in, not one to offer as an edit.
 */
function changedLayers(
  current: WorkspaceEntry,
  name: string,
  segment: string,
): { segment?: string; displayName?: string } {
  const displayName = name.trim()
  const next = segment.trim()
  return {
    ...(next === '' || next === current.segment ? {} : { segment: next }),
    ...(displayName === '' || displayName === current.displayName ? {} : { displayName }),
  }
}

export function WorkspaceMenu({
  current,
  workspaces,
  source,
  onSwitch,
  onRenamed,
}: WorkspaceMenuProps) {
  // One form at a time, as one state rather than two booleans: "creating and
  // renaming" is not a state this control has, and two flags would let it be
  // written.
  const [form, setForm] = useState<'none' | 'create' | 'rename'>('none')
  const [name, setName] = useState('')
  const [segment, setSegment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameId = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  // A ref, not the `busy` state below, and the difference is the whole guard.
  // `busy` is a React SNAPSHOT: a second submit that runs before React
  // re-renders still sees it false. The button's `disabled` covers a second
  // CLICK — React flushes discrete events synchronously — but this form also
  // submits on Enter and the input carries no disabled attribute.
  //
  // Measured rather than argued: two keydowns dispatched inside one batch
  // call `create` twice; the same two through `fireEvent`, which flushes
  // between them, call it once. Each browser create MINTS and persists a
  // workspace, so a second one is a workspace nobody asked for, holding a
  // segment that shifts the next real one to `-2`.
  const submitting = useRef(false)

  // Focused on REVEAL, not on mount: the form appears because the person
  // asked for it, and typing is the only thing to do next. `autoFocus` would
  // say the same thing to React and a different thing to a screen reader —
  // the attribute is about a document loading with focus already moved,
  // which is not what this is.
  useEffect(() => {
    if (form !== 'none') nameRef.current?.focus()
  }, [form])

  const active = workspaces.find((w) => workspaceHandle(w) === current)
  const create = source.create
  // Offered only once the list has answered: the form starts from the name
  // and segment the workspace HAS, and one pre-filled from the handle alone
  // would offer to overwrite a display name it never read.
  const rename = active === undefined ? undefined : source.rename

  const closeForm = () => {
    setForm('none')
    setError(null)
  }

  const failed = (cause: unknown, fallback: string) => {
    submitting.current = false
    setError(messageOf(cause, fallback))
    setBusy(false)
  }

  const submitCreate = () => {
    const displayName = name.trim()
    if (create === undefined || displayName === '' || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    create(displayName)
      .then((created) => {
        // The handle CREATE answered with, never the name that was typed: a
        // segment is derived from the name and may be suffixed past a
        // collision, or absent entirely, in which case the address is the
        // canonical id. Navigating to what was typed addresses nothing.
        onSwitch(workspaceHandle(created))
      })
      .catch((cause: unknown) => failed(cause, 'Could not create the workspace.'))
  }

  const submitRename = () => {
    if (rename === undefined || active === undefined || submitting.current) return
    const changed = changedLayers(active, name, segment)
    // Nothing to write is not a failure — it is a form submitted unchanged,
    // and the honest response is to close it rather than to report an error
    // about an edit nobody made.
    if (changed.segment === undefined && changed.displayName === undefined) {
      closeForm()
      return
    }
    submitting.current = true
    setBusy(true)
    setError(null)
    rename(active.workspaceId, changed)
      .then((renamed) => {
        submitting.current = false
        setBusy(false)
        setForm('none')
        // Taken from what rename ANSWERED rather than re-listed. A rename
        // that does not move the segment navigates nowhere and remounts
        // nothing, so the shell's own copy of the row is the only thing that
        // can tell the head its subject has a new name.
        onRenamed(renamed)
        // Only when the SEGMENT moved. The old handle stops answering the
        // moment it changes, so a page left on it is addressing a workspace
        // that is no longer there.
        const moved = workspaceHandle(renamed)
        if (moved !== current) onSwitch(moved)
      })
      .catch((cause: unknown) => failed(cause, 'Could not rename the workspace.'))
  }

  const submitForm = form === 'create' ? submitCreate : submitRename

  return (
    <>
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
                {isCurrent ? '✓' : ''}
              </span>
              <span className="truncate">{workspaceLabel(w)}</span>
            </button>
          )
        })}
      </div>
      {(create !== undefined || rename !== undefined) && (
        <div className="mt-1 border-t pt-1">
          {form === 'none' ? (
            <div role="menu" aria-label="Workspace actions" className="flex flex-col">
              {rename !== undefined && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    // Pre-filled from the row, so the form starts by stating
                    // what the workspace IS. An empty field would read as
                    // "no name", which is a different state and not this one.
                    setName(active?.displayName ?? '')
                    setSegment(active?.segment ?? '')
                    setForm('rename')
                  }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                >
                  <span aria-hidden="true" className="w-3.5 shrink-0 text-muted-foreground">
                    ✎
                  </span>
                  Rename workspace
                </button>
              )}
              {create !== undefined && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setName('')
                    setForm('create')
                  }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                >
                  <span aria-hidden="true" className="w-3.5 shrink-0 text-muted-foreground">
                    ＋
                  </span>
                  New workspace
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 p-1">
              <label htmlFor={nameId} className="text-xs text-muted-foreground">
                Workspace name
              </label>
              <input
                id={nameId}
                ref={nameRef}
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submitForm()
                }}
                className="rounded-md border bg-background px-2 py-1 text-sm"
              />
              {form === 'rename' && (
                <>
                  {/* No label naming this layer. ADR-0019 calls it the
                      `segment`, which is not a word to put in front of
                      somebody, and every other word for it invents a fourth
                      name for a layer that has three. Showing the URL it
                      lands in says the same thing without naming anything —
                      and it is the only rendering that makes the consequence
                      below obvious. */}
                  <div className="flex items-center rounded-md border bg-background px-2 py-1 font-mono text-xs">
                    <span aria-hidden="true" className="text-muted-foreground">
                      /w/
                    </span>
                    <input
                      aria-label="Workspace URL"
                      value={segment}
                      onChange={(event) => setSegment(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') submitForm()
                      }}
                      className="min-w-0 flex-1 bg-transparent outline-none"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Links using the old URL stop working.
                  </p>
                </>
              )}
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={busy || (form === 'create' && name.trim() === '')}
                  onClick={submitForm}
                  className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                >
                  {form === 'create' ? 'Create' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={closeForm}
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  )
}
