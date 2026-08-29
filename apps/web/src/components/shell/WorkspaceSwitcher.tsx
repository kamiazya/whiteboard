/**
 * The shell's statement of WHICH workspace you are in, and the way to
 * another one.
 *
 * The shell already declared itself the place that speaks about the
 * workspace — the connection chip was folded into the mark on exactly that
 * argument ("a workspace's keeper and its session are things about the
 * workspace, so they belong on the thing that names it"). What it never did
 * was NAME it. With one workspace that was invisible; with several it is the
 * gap, because a document page otherwise gives no clue which workspace its
 * document is in.
 *
 * It lives in the shell rather than on the index page for an address reason,
 * not a layout one: the workspace is the OUTERMOST layer of
 * `/w/:workspace/d/:path` (ADR-0019), so it is present on the document page
 * too, and a control that can only be reached by first going home cannot
 * change an address layer that every page carries.
 *
 * Switching is a callback, not a `navigate`, so the keeper that owns the
 * runtime consequences decides them: the browser has to re-point its
 * workspace identity and flush what is in flight before the route changes,
 * and a daemon has neither to do.
 */

import type { WorkspaceEntry } from '@kamiazya/whiteboard-ports'
import { useEffect, useId, useRef, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { workspaceHandle, workspaceLabel } from '@/lib/workspace-handle'

/**
 * Where the workspaces come from and how a new one is made — the one thing
 * this control does not decide, because it is the half that differs between
 * the keepers (IndexedDB here, HTTP there).
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
   * here means the control offers no creation at all, which is DESIGN.md's
   * standing rule — never offer what the keeper cannot honour — rather than
   * a disabled button, which would say "not right now" about something that
   * is not there.
   */
  create?(displayName: string): Promise<WorkspaceEntry>
  /**
   * Changes the two layers ADR-0019 lets a workspace's owner choose, and
   * answers the workspace as it now stands. Optional on the same rule as
   * `create`: absent means the keeper cannot rename, so nothing is offered.
   *
   * Takes the canonical `workspaceId`, never the handle — the address is
   * precisely what may be about to change, and naming the subject by the
   * thing being moved is how a rename addresses the wrong workspace.
   */
  rename?(
    workspaceId: string,
    input: { segment?: string; displayName?: string },
  ): Promise<WorkspaceEntry>
}

export interface WorkspaceSwitcherProps {
  /**
   * The handle the address currently carries, or `null` while it is
   * unresolved. Null renders nothing: a subject the shell cannot name is not
   * one it should invent a placeholder for.
   */
  readonly current: string | null
  readonly source: WorkspaceSwitcherSource
  readonly onSwitch: (handle: string) => void
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

/**
 * The layers this form actually CHANGED, in the port's own shape — absent
 * meaning "leave it alone".
 *
 * Submitting every field back would turn a display-name edit into an address
 * write, and the address write is the one that can fail on a collision. An
 * emptied address field is also absent rather than a clear: the port has no
 * way to clear a layer, and a workspace with no segment is a state it
 * arrives in, not one to offer as an edit.
 */
function changedLayers(
  current: WorkspaceEntry,
  name: string,
  address: string,
): { segment?: string; displayName?: string } {
  const displayName = name.trim()
  const segment = address.trim()
  return {
    ...(segment === '' || segment === current.segment ? {} : { segment }),
    ...(displayName === '' || displayName === current.displayName ? {} : { displayName }),
  }
}

export function WorkspaceSwitcher({ current, source, onSwitch }: WorkspaceSwitcherProps) {
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceEntry[]>([])
  // One form at a time, as one state rather than two booleans: "creating and
  // renaming" is not a state this control has, and two flags would let it be
  // written.
  const [form, setForm] = useState<'none' | 'create' | 'rename'>('none')
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameId = useId()
  const addressId = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  // A ref, not the `busy` state below, and the difference is the whole guard.
  // `busy` is a React SNAPSHOT: a second submit that runs before React
  // re-renders still sees it false. The Create button's `disabled` covers a
  // second CLICK — React flushes discrete events synchronously — but this
  // form also submits on Enter and the input carries no disabled attribute.
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

  useEffect(() => {
    let cancelled = false
    source
      .list()
      .then((rows) => {
        if (!cancelled) setWorkspaces(rows)
      })
      // A list that will not load leaves the trigger naming the address,
      // which is still true. Failing the whole shell over it would take the
      // settings gear and the connection popover down with it.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [source])

  if (current === null) return null

  // The address is known before the list is; showing the handle until the
  // row lands beats a blank or a spinner in a 40px row, and it is a true
  // statement about where we are rather than a placeholder.
  const active = workspaces.find((w) => workspaceHandle(w) === current)
  const label = active === undefined ? current : workspaceLabel(active)

  const create = source.create
  // Offered only once the list has answered: the form starts from the name
  // and address the workspace HAS, and one pre-filled from the handle alone
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
    const changed = changedLayers(active, name, address)
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
        // that does not move the address navigates nowhere and remounts
        // nothing, so the row this control holds is the only thing that can
        // tell the trigger its subject has a new name.
        setWorkspaces((rows) =>
          rows.map((row) => (row.workspaceId === renamed.workspaceId ? renamed : row)),
        )
        // Only when the ADDRESS moved. The old handle stops answering the
        // moment the segment changes, so a page left on it is addressing a
        // workspace that is no longer there.
        const moved = workspaceHandle(renamed)
        if (moved !== current) onSwitch(moved)
      })
      .catch((cause: unknown) => failed(cause, 'Could not rename the workspace.'))
  }

  const submitForm = form === 'create' ? submitCreate : submitRename

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="workspace-switcher-trigger"
          aria-label={`Workspace: ${label}`}
          className="min-w-0 shrink truncate rounded-md px-1.5 py-0.5 text-sm font-medium text-foreground/80 hover:bg-accent hover:text-foreground"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5 text-sm">
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
                // "unavailable", which is the wrong story about the place
                // you already are.
                {...(isCurrent ? { 'aria-current': 'true' } : {})}
                onClick={() => {
                  if (!isCurrent) onSwitch(handle)
                }}
                className="truncate rounded-md px-2 py-1.5 text-left hover:bg-accent aria-[current]:font-semibold"
              >
                {workspaceLabel(w)}
              </button>
            )
          })}
        </div>
        {(create !== undefined || rename !== undefined) && (
          <div className="mt-1 border-t pt-1">
            {form === 'none' ? (
              <>
                {rename !== undefined && (
                  <button
                    type="button"
                    onClick={() => {
                      // Pre-filled from the row, so the form starts by
                      // stating what the workspace IS. An empty field would
                      // read as "no name", which is a different workspace
                      // state and not this one.
                      setName(active?.displayName ?? '')
                      setAddress(active?.segment ?? '')
                      setForm('rename')
                    }}
                    className="w-full rounded-md px-2 py-1.5 text-left hover:bg-accent"
                  >
                    Rename workspace
                  </button>
                )}
                {create !== undefined && (
                  <button
                    type="button"
                    onClick={() => {
                      setName('')
                      setForm('create')
                    }}
                    className="w-full rounded-md px-2 py-1.5 text-left hover:bg-accent"
                  >
                    New workspace
                  </button>
                )}
              </>
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
                    <label htmlFor={addressId} className="text-xs text-muted-foreground">
                      Workspace address
                    </label>
                    <input
                      id={addressId}
                      value={address}
                      onChange={(event) => setAddress(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') submitForm()
                      }}
                      className="rounded-md border bg-background px-2 py-1 font-mono text-xs"
                    />
                    {/* The address is a separate field, and separately
                        edited, because it is what every link to this
                        workspace already says. Deriving it from the name
                        would break those links every time somebody fixed a
                        typo in the name. */}
                    <p className="text-xs text-muted-foreground">
                      Links using the old address stop working.
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
      </PopoverContent>
    </Popover>
  )
}
