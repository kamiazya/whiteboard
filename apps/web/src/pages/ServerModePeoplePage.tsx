/**
 * ADR-0049's two people screens on a server-mode keeper. The server's people
 * are its administrators' to manage (who is deactivated, who administers);
 * a workspace's people are its owners' (who is a member, who is an owner).
 * Every change goes to the keeper, which decides; this page shows what it
 * answered, including a refusal in the keeper's own words.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { WorkspacePeopleList } from '../components/people/WorkspacePeopleList.js'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog.js'
import { Button } from '../components/ui/button.js'
import { DESTRUCTIVE_COPY } from '../lib/destructive-copy.js'
import {
  type InvitationLink,
  type Outcome,
  type Refused,
  type TenantPerson,
  tenantPeople,
  workspacePeople,
} from '../lib/server-people.js'

type Fetch = typeof globalThis.fetch

function Layout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 p-6">
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
        All workspaces
      </Link>
      <h1 className="text-xl font-semibold">{title}</h1>
      {children}
    </main>
  )
}

/** A list the keeper answers, reloaded after each change; `null` while it is read. */
function useKeeperList<T>(read: () => Promise<Outcome<T>>) {
  const [state, setState] = useState<Outcome<T> | null>(null)
  const reload = useCallback(() => {
    let live = true
    void read().then((outcome) => {
      if (live) setState(outcome)
    })
    return () => {
      live = false
    }
  }, [read])
  useEffect(reload, [reload])
  return [state, reload] as const
}

/** Runs one change and reloads, keeping the keeper's refusal to show. */
function useChange(reload: () => void) {
  const [refusal, setRefusal] = useState<Refused | null>(null)
  const run = async (change: () => Promise<Outcome<unknown>>) => {
    const outcome = await change()
    setRefusal(outcome.ok ? null : outcome)
    reload()
  }
  return [refusal, run] as const
}

/**
 * Creates a single-use invitation link and shows it once, to copy. The link
 * is the secret, so it lives only in this page's state.
 */
/** A created link, shown once with a way to copy it. */
function InvitationLinkField({ link }: { link: InvitationLink }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard?.writeText(link.url).catch(() => undefined)
    setCopied(true)
  }
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm text-muted-foreground" htmlFor="invitation-link">
        Anyone who opens this link can use it once, until{' '}
        {/* time-format-is-deliberate: an expiry is ahead, and formatRelative words only the past */}
        {new Date(link.expiresAt).toLocaleString()}. It is shown only now.
      </label>
      <div className="flex gap-2">
        <input
          id="invitation-link"
          readOnly
          value={link.url}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-md border px-2 py-1 text-sm"
        />
        <Button variant="outline" size="sm" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}

/**
 * Creates a single-use invitation link and shows it once, to copy. The link
 * is the secret, so it lives only in this page's state.
 */
function InvitationControl({ create }: { create: () => Promise<Outcome<InvitationLink>> }) {
  const [link, setLink] = useState<InvitationLink | null>(null)
  const [refusal, setRefusal] = useState<Refused | null>(null)
  const make = async () => {
    const outcome = await create()
    if (outcome.ok) {
      setLink(outcome.value)
      setRefusal(null)
    } else setRefusal(outcome)
  }
  return (
    <section className="flex flex-col gap-2">
      <Button variant="outline" className="self-start" onClick={() => void make()}>
        Create invitation link
      </Button>
      {refusal !== null && <Refusal refusal={refusal} />}
      {/* Keyed on the link, so a new one starts uncopied. */}
      {link !== null && <InvitationLinkField key={link.url} link={link} />}
    </section>
  )
}

function Refusal({ refusal }: { refusal: Refused | null }) {
  const { pathname, search } = useLocation()
  const back = `/auth/reauthenticate?return=${encodeURIComponent(pathname + search)}`
  // Mounted even when empty: a live region inserted with its text already
  // in it is not announced. The sign-in is a full navigation to the keeper,
  // which returns here; the change is then made again by the person.
  return (
    <div className="flex flex-col gap-1">
      <p role="alert" className="text-sm text-destructive">
        {refusal?.message ?? ''}
      </p>
      {refusal?.reauthenticate === true && (
        <a href={back} className="self-start text-sm underline">
          Sign in again
        </a>
      )}
    </div>
  )
}

interface PersonActionsProps {
  person: TenantPerson
  run: (change: () => Promise<Outcome<unknown>>) => Promise<void>
  fetchFn: Fetch
  onDelete: () => void
}

/** What an administrator can do to someone else on the server. */
function PersonActions({ person, run, fetchFn, onDelete }: PersonActionsProps) {
  const { userId, displayName, deactivated, administrator } = person
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          void run(() => tenantPeople.setAdministrator(fetchFn, userId, !administrator))
        }
      >
        {administrator
          ? `Remove ${displayName} as administrator`
          : `Make ${displayName} an administrator`}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void run(() => tenantPeople.setDeactivated(fetchFn, userId, !deactivated))}
      >
        {deactivated ? `Reactivate ${displayName}` : `Deactivate ${displayName}`}
      </Button>
      {/* ADR-0051: deleting follows deactivation, never replaces it. */}
      {deactivated && (
        <Button variant="outline" size="sm" className="text-destructive" onClick={onDelete}>
          {`Delete ${displayName}`}
        </Button>
      )}
    </>
  )
}

function TenantPersonRow({ isSelf, ...actions }: PersonActionsProps & { isSelf: boolean }) {
  const { displayName, deactivated, administrator } = actions.person
  const notes = [administrator && 'Administrator', deactivated && 'Deactivated', isSelf && 'You']
  return (
    <li className="flex flex-wrap items-center gap-2 border-b py-2">
      <span className="font-medium">{displayName}</span>
      <span className="text-sm text-muted-foreground">{notes.filter(Boolean).join(' · ')}</span>
      <span className="flex-1" />
      {!isSelf && <PersonActions {...actions} />}
    </li>
  )
}

/**
 * The one confirmation for deleting a person (ADR-0051). Focus goes to the
 * list afterwards, since the row whose button opened it may be gone.
 */
function DeletePersonDialog({
  person,
  onClose,
  onConfirm,
  focusAfter,
}: {
  person: TenantPerson | null
  onClose: () => void
  onConfirm: (person: TenantPerson) => void
  focusAfter: () => HTMLElement | null
}) {
  const name = person?.displayName ?? ''
  return (
    <AlertDialog open={person !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          focusAfter()?.focus()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{`Delete ${name}`}</AlertDialogTitle>
          <AlertDialogDescription>{DESTRUCTIVE_COPY['delete-person'](name)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => person !== null && onConfirm(person)}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** The server's people, for its administrators (ADR-0049 decisions 1, 2, 4). */
export function TenantPeoplePage({ fetchFn, selfId }: { fetchFn: Fetch; selfId: string }) {
  const read = useCallback(() => tenantPeople.list(fetchFn), [fetchFn])
  const [list, reload] = useKeeperList(read)
  const [refusal, run] = useChange(reload)
  const invite = useCallback(() => tenantPeople.invite(fetchFn), [fetchFn])
  const [deleting, setDeleting] = useState<TenantPerson | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  return (
    <Layout title="People on this server">
      <InvitationControl create={invite} />
      <Refusal refusal={refusal ?? (list !== null && !list.ok ? list : null)} />
      {list?.ok && (
        <ul ref={listRef} tabIndex={-1} aria-label="People" className="flex flex-col">
          {list.value.people.map((person) => (
            <TenantPersonRow
              key={person.userId}
              person={person}
              isSelf={person.userId === selfId}
              run={run}
              fetchFn={fetchFn}
              onDelete={() => setDeleting(person)}
            />
          ))}
        </ul>
      )}
      <DeletePersonDialog
        person={deleting}
        onClose={() => setDeleting(null)}
        onConfirm={(person) => void run(() => tenantPeople.delete(fetchFn, person.userId))}
        focusAfter={() => listRef.current}
      />
    </Layout>
  )
}

/** A workspace's people: any member reads them, those the keeper allows change them. */
export function WorkspacePeoplePage({ fetchFn }: { fetchFn: Fetch }) {
  const workspaceId = useParams().workspace ?? ''
  const invite = useCallback(
    () => workspacePeople.invite(fetchFn, workspaceId),
    [fetchFn, workspaceId],
  )
  return (
    <Layout title="People in this workspace">
      <WorkspacePeopleList
        fetchFn={fetchFn}
        workspaceId={workspaceId}
        adding={<InvitationControl create={invite} />}
      />
    </Layout>
  )
}
