/**
 * "New workspace" for the signed-in person's workspace list in the web app a
 * server-mode keeper serves (ADR-0047).
 *
 * It asks the same `KeeperWorkspaces` seam the daemon's switcher menu is built
 * on (`hooks/use-shell-workspaces.ts`) rather than posting on its own, so a
 * workspace made here and one made there are the same call. The keeper makes
 * the caller the first member and owner, which is why this is the way a fresh
 * server's first person gets anywhere: nothing else in the app creates one.
 */
import { membershipRefusalSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import { messageOf } from '@kamiazya/whiteboard-model'
import { useRef, useState } from 'react'
import { z } from 'zod'
import { isImeComposingKeydown } from '../../lib/ime-keydown.js'
import { workspaceHandle } from '../../lib/workspace-handle.js'
import type { KeeperWorkspaces } from '../../lib/workspace-switcher-source.js'
import { Button } from '../ui/button.js'

const GENERIC_FAILURE = 'Could not create the workspace. Nothing was created. Try again.'

// Read by CODE, as `membership-refusal.ts` does, not by the sentence: the
// sentence is the keeper's to reword. Structural rather than `instanceof
// DaemonApiError`, which would pull the whole daemon client into this page's
// chunk and defeat the seam's lazy import of it.
const refusalSchema = z.object({ status: z.literal(403), body: membershipRefusalSchema })

/** What the person reads when the keeper refused or the call failed. */
function failureCopy(cause: unknown): string {
  const refusal = refusalSchema.safeParse(cause)
  if (refusal.success && refusal.data.body.error === 'requires_person_session') {
    return 'This session is not signed in as a person, so the server did not create a workspace. Nothing was created. Sign out, sign in again, and try once more.'
  }
  return messageOf(cause, GENERIC_FAILURE)
}

/**
 * The create call and what it leaves behind: busy, and the words for a
 * failure. A failed create keeps the form open with what was typed.
 */
function useCreate({ source, onSwitch }: KeeperWorkspaces) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A ref beside `busy`: state is a snapshot, so a second Enter dispatched
  // before React re-renders still reads it false, and each create mints a
  // workspace the person then has to find and be rid of.
  const submitting = useRef(false)
  const submit = (typed: string) => {
    const displayName = typed.trim()
    if (source.create === undefined || displayName === '' || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    source
      .create(displayName)
      // The handle the keeper answered with, never the typed name: the
      // address is derived from it and may be suffixed or absent.
      .then((created) => onSwitch(workspaceHandle(created)))
      .catch((cause: unknown) => {
        submitting.current = false
        setBusy(false)
        setError(failureCopy(cause))
      })
  }
  return { busy, error, submit, clearError: () => setError(null) }
}

function NameField({
  value,
  error,
  onChange,
}: {
  value: string
  error: string | null
  onChange: (next: string) => void
}) {
  return (
    <>
      <label htmlFor="new-workspace-name" className="text-sm text-muted-foreground">
        New workspace name
      </label>
      <input
        id="new-workspace-name"
        // The form exists because the person asked for it, so moving focus
        // into it is following them rather than taking it.
        // biome-ignore lint/a11y/noAutofocus: opened by an explicit click
        autoFocus
        enterKeyHint="done"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // A conversion-confirming Enter is not "I am done".
          if (event.key === 'Enter' && isImeComposingKeydown(event.nativeEvent)) {
            event.preventDefault()
          }
        }}
        aria-invalid={error !== null}
        aria-describedby={error === null ? undefined : 'new-workspace-error'}
        className="rounded-md border bg-background px-2 py-1 text-sm"
      />
      {error !== null && (
        <p id="new-workspace-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  )
}

function NewWorkspaceForm({
  workspaces,
  onCancel,
}: {
  workspaces: KeeperWorkspaces
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const { busy, error, submit, clearError } = useCreate(workspaces)
  return (
    <form
      className="flex w-full max-w-md flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        submit(name)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        clearError()
        onCancel()
      }}
    >
      <NameField value={name} error={error} onChange={setName} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || name.trim() === ''}>
          Create
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

export function NewWorkspaceControl({ workspaces }: { workspaces: KeeperWorkspaces }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  if (workspaces.source.create === undefined) return null
  if (open) {
    return (
      <NewWorkspaceForm
        workspaces={workspaces}
        onCancel={() => {
          setOpen(false)
          // The control that opened the form is where the person was.
          queueMicrotask(() => trigger.current?.focus())
        }}
      />
    )
  }
  return (
    <Button ref={trigger} variant="outline" onClick={() => setOpen(true)}>
      New workspace
    </Button>
  )
}
