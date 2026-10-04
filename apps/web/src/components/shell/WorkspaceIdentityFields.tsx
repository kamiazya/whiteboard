/**
 * The two layers of a workspace's identity its owner may choose — the name,
 * and the address it is reached at — as fields edited in place.
 *
 * Shared by every shell that offers a rename (the switcher menu's head, and
 * the server-mode shell), so a refusal reads the same wherever it is written.
 */

import { messageOf } from '@kamiazya/whiteboard-model'
import type { RenameWorkspaceInput, WorkspaceEntry } from '@kamiazya/whiteboard-ports'
import { useId, useRef, useState } from 'react'
import { isImeComposingKeydown } from '../../lib/ime-keydown.js'
import { workspaceHandle } from '../../lib/workspace-handle.js'
import type { WorkspaceRow, WorkspaceSwitcherSource } from '../../lib/workspace-switcher-source.js'

export interface WorkspaceIdentityFieldsProps {
  readonly active: WorkspaceRow
  /** The handle the address currently carries. */
  readonly current: string | null
  /** Absent where the keeper cannot rename: the fields then read, never hide. */
  readonly rename: WorkspaceSwitcherSource['rename']
  /** Replaces a row in the caller's copy after a rename answers. */
  readonly onRenamed: (entry: WorkspaceEntry) => void
  readonly onSwitch: (handle: string) => void
  /** The session word, shown beside the name. `null` where no page holds one. */
  readonly sessionLabel?: string | null
  /** A failure from the caller's own action, shown where a rename failure is. */
  readonly notice?: string | null
  readonly className?: string
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

/**
 * The rename call and what it leaves behind: the words for a refusal. Each
 * write is its own call, so a failed one never blocks the next.
 */
function useRenameWrite({
  active,
  current,
  rename,
  onRenamed,
  onSwitch,
}: Pick<WorkspaceIdentityFieldsProps, 'active' | 'current' | 'rename' | 'onRenamed' | 'onSwitch'>) {
  const [error, setError] = useState<string | null>(null)
  const write = (input: RenamedLayers) => {
    if (rename === undefined) return
    setError(null)
    rename(active.workspaceId, input)
      .then((renamed) => {
        // Taken from what rename ANSWERED rather than re-listed: a name edit
        // navigates nowhere and remounts nothing, so the caller's own copy of
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
  return { error, write }
}

interface FieldProps {
  readonly active: WorkspaceRow
  readonly canWrite: boolean
  readonly write: (input: RenamedLayers) => void
}

/**
 * Every keystroke is committed. `draft` null means "not being edited", so the
 * box shows the stored value; while it is a string the box shows THAT, because
 * a committed name comes back normalised and re-rendering the normalised form
 * on the keystroke that typed a space erases it — "Design team" typed one key
 * at a time would arrive as "Designteam". Same reason `DocumentProperties`
 * holds a draft.
 *
 * `baseline` is what the name held when the edit began: with every keystroke
 * already committed Escape has nothing to discard, so it has to put the
 * previous name BACK, or "type, change your mind, Escape" silently keeps the
 * half-typed one. It is compared against what the BOX holds, never against
 * the stored name: the commit is async, so the row can still carry the old
 * name and comparing to it would decide "nothing changed" while a rename is
 * already in flight.
 */
function NameField({ active, canWrite, write }: FieldProps) {
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const baseline = useRef(active.displayName ?? '')
  return (
    <>
      <label className="sr-only" htmlFor={id}>
        Workspace name
      </label>
      <input
        id={id}
        value={draft ?? active.displayName ?? ''}
        readOnly={!canWrite}
        placeholder="Unnamed workspace"
        onFocus={() => {
          baseline.current = active.displayName ?? ''
        }}
        onChange={(event) => {
          if (!canWrite) return
          setDraft(event.target.value)
          if (unchanged(event.target.value, active.displayName)) return
          write({ displayName: event.target.value.trim() })
        }}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key !== 'Escape' || !canWrite) return
          event.preventDefault()
          const shown = draft ?? active.displayName ?? ''
          setDraft(null)
          if (shown !== baseline.current && baseline.current !== '') {
            write({ displayName: baseline.current })
          }
          event.currentTarget.blur()
        }}
        onBlur={() => setDraft(null)}
        className="min-w-0 flex-1 truncate bg-transparent text-sm font-semibold outline-none placeholder:font-normal placeholder:text-muted-foreground"
      />
    </>
  )
}

/**
 * The URL's draft is not the name's device. It is the PENDING edit: this field
 * does not commit per keystroke, so the draft is what has not been written yet
 * rather than a rendering workaround. It commits on blur too: leaving a field
 * having typed in it and losing the edit silently is the worse of the two
 * surprises.
 *
 * No label names this layer. ADR-0019 calls it the `segment`, which is not a
 * word to put in front of somebody, and every plainer word invents a FOURTH
 * name for a layer that has three. The URL it lands in says the same thing
 * without naming anything.
 */
function UrlField({ active, canWrite, write }: FieldProps) {
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    setDraft(null)
    if (unchanged(draft, active.segment)) return
    write({ segment: draft.trim() })
  }
  return (
    <>
      <div className="flex items-center rounded-md border bg-background px-1.5 py-0.5 font-mono text-xs">
        <span aria-hidden="true" className="text-muted-foreground">
          /w/
        </span>
        <label className="sr-only" htmlFor={id}>
          Workspace URL
        </label>
        <input
          id={id}
          enterKeyHint="done"
          value={draft ?? active.segment ?? ''}
          readOnly={!canWrite}
          placeholder={active.workspaceId}
          onChange={(event) => {
            if (canWrite) setDraft(event.target.value)
          }}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter') {
              if (isImeComposingKeydown(event.nativeEvent)) return
              event.preventDefault()
              commit()
              return
            }
            if (event.key !== 'Escape') return
            event.preventDefault()
            setDraft(null)
            event.currentTarget.blur()
          }}
          onBlur={commit}
          className="min-w-0 flex-1 bg-transparent outline-none"
        />
      </div>
      {draft !== null && !unchanged(draft, active.segment) && (
        <p className="text-xs text-muted-foreground">Links using the old URL stop working.</p>
      )}
    </>
  )
}

export function WorkspaceIdentityFields(props: WorkspaceIdentityFieldsProps) {
  const { active, rename, sessionLabel, notice, className } = props
  const { error, write } = useRenameWrite(props)
  const field = { active, canWrite: rename !== undefined, write }
  const shownError = error ?? notice ?? null
  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <NameField {...field} />
        {sessionLabel != null && (
          <span className="shrink-0 text-xs font-medium text-muted-foreground">{sessionLabel}</span>
        )}
      </div>
      <UrlField {...field} />
      {shownError && (
        <p role="alert" className="text-xs text-destructive">
          {shownError}
        </p>
      )}
    </div>
  )
}
