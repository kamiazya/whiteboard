/**
 * A workspace's people, as both keepers answer them (ADR-0049 decision 5):
 * who is in it, whether each is an owner, and — for a caller the keeper says
 * may change them — the controls to make someone an owner or a member and to
 * remove them. Removing a person asks first, because it ends their access
 * at once.
 *
 * How a person is ADDED differs by keeper (an invitation link on a server, a
 * pinned passkey on the local daemon), so the caller hands that part in as
 * `adding`, shown only to someone who may change the list.
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { DESTRUCTIVE_COPY } from '../../lib/destructive-copy.js'
import { type Outcome, type WorkspacePerson, workspacePeople } from '../../lib/server-people.js'
import { Button } from '../ui/button.js'
import { PinnedConfirmDialog } from '../ui/pinned-confirm-dialog.js'

type Fetch = typeof globalThis.fetch

interface Listed {
  readonly people: readonly WorkspacePerson[]
  readonly canManage: boolean
}

/** The list the keeper answers, read again whenever the keeper or workspace changes, or `reload` is called. */
function useWorkspacePeople(fetchFn: Fetch, workspaceId: string) {
  const [listed, setListed] = useState<Outcome<Listed> | null>(null)
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    // A newer read, or a different keeper, makes this answer nobody's.
    let live = true
    void workspacePeople.list(fetchFn, workspaceId).then((outcome) => {
      if (live) setListed(outcome)
    })
    return () => {
      live = false
    }
  }, [fetchFn, workspaceId, generation])
  const reload = useCallback(() => setGeneration((g) => g + 1), [])
  return [listed, reload] as const
}

function PersonRow({
  person,
  canManage,
  onRole,
  onRemove,
}: {
  person: WorkspacePerson
  canManage: boolean
  onRole: () => void
  onRemove: (trigger: HTMLButtonElement) => void
}) {
  const { displayName, role, deactivated } = person
  const notes = [role === 'owner' ? 'Owner' : 'Member', deactivated && 'Deactivated']
  return (
    <li className="flex flex-wrap items-center gap-2 border-b py-2 text-sm">
      <span className="font-medium">{displayName}</span>
      <span className="text-muted-foreground">{notes.filter(Boolean).join(' · ')}</span>
      <span className="flex-1" />
      {canManage && (
        <>
          <Button variant="outline" size="sm" onClick={onRole}>
            {role === 'owner' ? `Make ${displayName} a member` : `Make ${displayName} an owner`}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive"
            onClick={(event) => onRemove(event.currentTarget)}
          >
            {`Remove ${displayName}`}
          </Button>
        </>
      )}
    </li>
  )
}

/** The changes a manager makes, each ending in a reload and a sentence to announce. */
function usePeopleChanges(fetchFn: Fetch, workspaceId: string, reload: () => void) {
  const [status, setStatus] = useState<string | null>(null)
  const [pending, setPending] = useState<WorkspacePerson | null>(null)
  const [removing, setRemoving] = useState(false)
  const removedRef = useRef(false)
  const say = (outcome: Outcome<unknown>, done: string) => {
    setStatus(outcome.ok ? done : outcome.message)
    reload()
  }
  const changeRole = async (person: WorkspacePerson) => {
    const role = person.role === 'owner' ? 'member' : 'owner'
    const outcome = await workspacePeople.setRole(fetchFn, workspaceId, person.userId, role)
    say(outcome, `${person.displayName} is now ${role === 'owner' ? 'an owner' : 'a member'}.`)
  }
  const remove = async (person: WorkspacePerson) => {
    setRemoving(true)
    const outcome = await workspacePeople.remove(fetchFn, workspaceId, person.userId)
    removedRef.current = outcome.ok
    say(outcome, `${person.displayName} was removed.`)
    setRemoving(false)
    setPending(null)
  }
  return { status, pending, setPending, removing, removedRef, changeRole, remove }
}

/**
 * The one confirmation every row shares. Focus goes back to the row's button
 * by hand — unless the removal succeeded and that button is gone, when it
 * goes to the line announcing what happened.
 */
function RemovePersonDialog({
  pending,
  removing,
  onClose,
  onConfirm,
  focusAfter,
}: {
  pending: WorkspacePerson | null
  removing: boolean
  onClose: () => void
  onConfirm: () => void
  focusAfter: () => HTMLElement | null
}) {
  return (
    <PinnedConfirmDialog
      open={pending !== null}
      busy={removing}
      title={`Remove ${pending?.displayName ?? ''}?`}
      description={DESTRUCTIVE_COPY['remove-member'](pending?.displayName ?? '')}
      confirmLabel="Remove"
      onCancel={onClose}
      onConfirm={onConfirm}
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        focusAfter()?.focus()
      }}
    />
  )
}

function PeopleRows({
  listed,
  onRole,
  onRemove,
}: {
  listed: Outcome<Listed> | null
  onRole: (person: WorkspacePerson) => void
  onRemove: (person: WorkspacePerson, trigger: HTMLButtonElement) => void
}) {
  if (listed === null) return null
  if (!listed.ok) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {listed.message}
      </p>
    )
  }
  const { people, canManage } = listed.value
  if (people.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No one has been added to this workspace yet.</p>
    )
  }
  return (
    <ul className="flex flex-col">
      {people.map((person) => (
        <PersonRow
          key={person.userId}
          person={person}
          canManage={canManage}
          onRole={() => onRole(person)}
          onRemove={(trigger) => onRemove(person, trigger)}
        />
      ))}
    </ul>
  )
}

export function WorkspacePeopleList({
  fetchFn,
  workspaceId,
  adding,
}: {
  fetchFn: Fetch
  workspaceId: string
  adding?: ReactNode
}) {
  const [listed, reload] = useWorkspacePeople(fetchFn, workspaceId)
  const changes = usePeopleChanges(fetchFn, workspaceId, reload)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const statusRef = useRef<HTMLParagraphElement>(null)
  const people = listed?.ok ? listed.value : null
  return (
    <div className="flex flex-col gap-3">
      {people?.canManage && adding}
      {/* Mounted before it speaks: a live region that arrives with its
          message is announced inconsistently. */}
      <p role="status" aria-live="polite" ref={statusRef} tabIndex={-1} className="text-sm">
        {changes.status ?? ''}
      </p>
      <PeopleRows
        listed={listed}
        onRole={(person) => void changes.changeRole(person)}
        onRemove={(person, trigger) => {
          triggerRef.current = trigger
          changes.setPending(person)
        }}
      />
      <RemovePersonDialog
        pending={changes.pending}
        removing={changes.removing}
        onClose={() => changes.setPending(null)}
        onConfirm={() => {
          if (changes.pending !== null) void changes.remove(changes.pending)
        }}
        focusAfter={() => {
          const removed = changes.removedRef.current
          changes.removedRef.current = false
          return removed ? statusRef.current : triggerRef.current
        }}
      />
    </div>
  )
}
