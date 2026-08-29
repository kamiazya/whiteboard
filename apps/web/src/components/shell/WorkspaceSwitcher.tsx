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
 * Switching is a callback, not a `navigate` — the two keepers settle it
 * differently. The browser resolves its active workspace once, into a
 * synchronous singleton whose whole rationale is that re-pointing it in
 * place would ripple through every call site that reads it, so a browser
 * switch is a document load. A daemon holds no such singleton.
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

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Could not create the workspace.'
}

export function WorkspaceSwitcher({ current, source, onSwitch }: WorkspaceSwitcherProps) {
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceEntry[]>([])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameId = useId()
  const nameRef = useRef<HTMLInputElement>(null)

  // Focused on REVEAL, not on mount: the form appears because the person
  // asked for it, and typing is the only thing to do next. `autoFocus` would
  // say the same thing to React and a different thing to a screen reader —
  // the attribute is about a document loading with focus already moved,
  // which is not what this is.
  useEffect(() => {
    if (creating) nameRef.current?.focus()
  }, [creating])

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
  const submit = () => {
    const displayName = name.trim()
    if (create === undefined || displayName === '' || busy) return
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
      .catch((cause: unknown) => {
        setError(messageOf(cause))
        setBusy(false)
      })
  }

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
        {create !== undefined && (
          <div className="mt-1 border-t pt-1">
            {creating ? (
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
                    if (event.key === 'Enter') submit()
                  }}
                  className="rounded-md border bg-background px-2 py-1 text-sm"
                />
                {error && (
                  <p role="alert" className="text-xs text-destructive">
                    {error}
                  </p>
                )}
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    disabled={busy || name.trim() === ''}
                    onClick={submit}
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
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="w-full rounded-md px-2 py-1.5 text-left hover:bg-accent"
              >
                New workspace
              </button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
