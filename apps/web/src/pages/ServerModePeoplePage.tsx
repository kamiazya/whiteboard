/**
 * ADR-0049's two people screens on a server-mode keeper. The server's people
 * are its administrators' to manage (who is deactivated, who administers);
 * a workspace's people are its owners' (who is a member, who is an owner).
 * Every change goes to the keeper, which decides; this page shows what it
 * answered, including a refusal in the keeper's own words.
 */
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button } from '../components/ui/button.js'
import {
  type InvitationLink,
  type Outcome,
  type TenantPerson,
  tenantPeople,
  type WorkspacePerson,
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
  const [refusal, setRefusal] = useState<string | null>(null)
  const run = async (change: () => Promise<Outcome<unknown>>) => {
    const outcome = await change()
    setRefusal(outcome.ok ? null : outcome.message)
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
  const [refusal, setRefusal] = useState<string | null>(null)
  const make = async () => {
    const outcome = await create()
    if (outcome.ok) {
      setLink(outcome.value)
      setRefusal(null)
    } else setRefusal(outcome.message)
  }
  return (
    <section className="flex flex-col gap-2">
      <Button variant="outline" className="self-start" onClick={() => void make()}>
        Create invitation link
      </Button>
      {refusal !== null && (
        <p role="alert" className="text-sm text-destructive">
          {refusal}
        </p>
      )}
      {/* Keyed on the link, so a new one starts uncopied. */}
      {link !== null && <InvitationLinkField key={link.url} link={link} />}
    </section>
  )
}

function Refusal({ message }: { message: string | null }) {
  // Mounted even when empty: a live region inserted with its text already
  // in it is not announced.
  return (
    <p role="alert" className="text-sm text-destructive">
      {message ?? ''}
    </p>
  )
}

function TenantPersonRow({
  person,
  isSelf,
  run,
  fetchFn,
}: {
  person: TenantPerson
  isSelf: boolean
  run: (change: () => Promise<Outcome<unknown>>) => Promise<void>
  fetchFn: Fetch
}) {
  const { userId, displayName, deactivated, administrator } = person
  const notes = [administrator && 'Administrator', deactivated && 'Deactivated', isSelf && 'You']
  return (
    <li className="flex flex-wrap items-center gap-2 border-b py-2">
      <span className="font-medium">{displayName}</span>
      <span className="text-sm text-muted-foreground">{notes.filter(Boolean).join(' · ')}</span>
      <span className="flex-1" />
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
      {!isSelf && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void run(() => tenantPeople.setDeactivated(fetchFn, userId, !deactivated))}
        >
          {deactivated ? `Reactivate ${displayName}` : `Deactivate ${displayName}`}
        </Button>
      )}
    </li>
  )
}

/** The server's people, for its administrators (ADR-0049 decisions 1, 2, 4). */
export function TenantPeoplePage({ fetchFn, selfId }: { fetchFn: Fetch; selfId: string }) {
  const read = useCallback(() => tenantPeople.list(fetchFn), [fetchFn])
  const [list, reload] = useKeeperList(read)
  const [refusal, run] = useChange(reload)
  const invite = useCallback(() => tenantPeople.invite(fetchFn), [fetchFn])
  return (
    <Layout title="People on this server">
      <InvitationControl create={invite} />
      <Refusal message={refusal ?? (list !== null && !list.ok ? list.message : null)} />
      {list?.ok && (
        <ul className="flex flex-col">
          {list.value.people.map((person) => (
            <TenantPersonRow
              key={person.userId}
              person={person}
              isSelf={person.userId === selfId}
              run={run}
              fetchFn={fetchFn}
            />
          ))}
        </ul>
      )}
    </Layout>
  )
}

function WorkspacePersonRow({
  person,
  canManage,
  run,
  fetchFn,
  workspaceId,
}: {
  person: WorkspacePerson
  canManage: boolean
  run: (change: () => Promise<Outcome<unknown>>) => Promise<void>
  fetchFn: Fetch
  workspaceId: string
}) {
  const { userId, displayName, role, deactivated } = person
  const notes = [role === 'owner' ? 'Owner' : 'Member', deactivated && 'Deactivated']
  return (
    <li className="flex flex-wrap items-center gap-2 border-b py-2">
      <span className="font-medium">{displayName}</span>
      <span className="text-sm text-muted-foreground">{notes.filter(Boolean).join(' · ')}</span>
      <span className="flex-1" />
      {canManage && (
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void run(() =>
                workspacePeople.setRole(
                  fetchFn,
                  workspaceId,
                  userId,
                  role === 'owner' ? 'member' : 'owner',
                ),
              )
            }
          >
            {role === 'owner' ? `Make ${displayName} a member` : `Make ${displayName} an owner`}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void run(() => workspacePeople.remove(fetchFn, workspaceId, userId))}
          >
            {`Remove ${displayName}`}
          </Button>
        </>
      )}
    </li>
  )
}

/** A workspace's people: any member reads them, its owners change them. */
export function WorkspacePeoplePage({ fetchFn, selfId }: { fetchFn: Fetch; selfId: string }) {
  const workspaceId = useParams().workspace ?? ''
  const read = useCallback(() => workspacePeople.list(fetchFn, workspaceId), [fetchFn, workspaceId])
  const [list, reload] = useKeeperList(read)
  const [refusal, run] = useChange(reload)
  const invite = useCallback(
    () => workspacePeople.invite(fetchFn, workspaceId),
    [fetchFn, workspaceId],
  )
  const people = list?.ok ? list.value.people : []
  const isOwner = people.some((p) => p.userId === selfId && p.role === 'owner')
  return (
    <Layout title="People in this workspace">
      {isOwner && <InvitationControl create={invite} />}
      <Refusal message={refusal ?? (list !== null && !list.ok ? list.message : null)} />
      <ul className="flex flex-col">
        {people.map((person) => (
          <WorkspacePersonRow
            key={person.userId}
            person={person}
            canManage={isOwner}
            run={run}
            fetchFn={fetchFn}
            workspaceId={workspaceId}
          />
        ))}
      </ul>
    </Layout>
  )
}
