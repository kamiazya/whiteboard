import {
  apiErrorReason,
  listCredentialsResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import {
  listMembersResponseSchema,
  type MemberProfileSummary,
  memberProfileSummarySchema,
  removeMemberResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import { type RefObject, useCallback, useEffect, useId, useRef, useState } from 'react'
import type { z } from 'zod'
import { useDaemonApi } from '../../contexts/DaemonApiContext.js'
import { DESTRUCTIVE_COPY } from '../../lib/destructive-copy.js'
import { SquiggleLoader } from '../SquiggleLoader.js'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog.js'
import { Button } from '../ui/button.js'

type PinnedPasskey = z.infer<typeof listCredentialsResponseSchema>['credentials'][number]

type CardState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'loaded'; members: readonly MemberProfileSummary[]; pins: readonly PinnedPasskey[] }

function membersUrl(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/members`
}

/**
 * One read, judged against the generation that started it.
 *
 * `stale` is NOT an error and must not be drawn as one: it means a newer
 * read (or a daemon-identity change) overtook this one, and whatever answer
 * arrives belongs to a question nobody is asking any more. The check happens
 * twice — after the fetch and after the body — because the body is a second
 * await and the generation can move across either.
 *
 * A network throw is the caller's to catch: it cannot be told from a stale
 * abort here, and the caller knows which of its own reads was in flight.
 */
async function readCurrent<T>(
  fetchApi: (url: string) => Promise<Response>,
  url: string,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  generation: number,
  generationRef: RefObject<number>,
): Promise<{ kind: 'ok'; value: T } | { kind: 'stale' } | { kind: 'error' }> {
  const res = await fetchApi(url)
  if (generation !== generationRef.current) return { kind: 'stale' }
  if (!res.ok) return { kind: 'error' }
  const parsed = schema.safeParse(await res.json())
  if (generation !== generationRef.current) return { kind: 'stale' }
  if (!parsed.success) return { kind: 'error' }
  return { kind: 'ok', value: parsed.data }
}

/**
 * What the add form is asking for, or `null` when it is not asking for
 * anything yet: no pin chosen, or a name that is only whitespace. Both are
 * a silent no-op rather than an error, because neither is a failure — the
 * person has not finished.
 */
function addMemberRequest(
  data: FormData,
  pins: readonly { credentialId: string; origin: string }[],
): { credentialId: string; origin: string; displayName: string } | null {
  const pin = pins[Number(data.get('credentialIndex'))]
  const displayName = String(data.get('displayName') ?? '').trim()
  if (pin === undefined || displayName.length === 0) return null
  return { credentialId: pin.credentialId, origin: pin.origin, displayName }
}

/**
 * The add itself, judged against the generation that started it. `stale` is
 * not an error for the reason `readCurrent` gives; an error carries the
 * daemon's own reason when it sent one, because "Request failed (400)" tells
 * a person nothing they can act on.
 */
async function postMember(
  fetchApi: (url: string, init?: RequestInit) => Promise<Response>,
  workspaceId: string,
  request: { credentialId: string; origin: string; displayName: string },
  generation: number,
  generationRef: RefObject<number>,
): Promise<
  | { kind: 'ok'; value: z.infer<typeof memberProfileSummarySchema> }
  | { kind: 'stale' }
  | { kind: 'error'; message: string }
> {
  const res = await fetchApi(membersUrl(workspaceId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (generation !== generationRef.current) return { kind: 'stale' }
  if (!res.ok) {
    const reason = apiErrorReason(await res.json().catch(() => undefined))
    return { kind: 'error', message: reason ?? `Request failed (${res.status}).` }
  }
  const parsed = memberProfileSummarySchema.safeParse(await res.json())
  if (generation !== generationRef.current) return { kind: 'stale' }
  if (!parsed.success) return { kind: 'error', message: `Request failed (${res.status}).` }
  return { kind: 'ok', value: parsed.data }
}

/**
 * Settings > Connections' "This workspace" members list: the people a daemon
 * workspace admits (ADR-0041 L1), pinned passkeys turned into members and
 * removed with a confirm step. Structured after PasskeysCard, the sibling
 * card that manages the pins a member is built from.
 */
export function MembersCard({ workspaceId }: { workspaceId: string }) {
  const fetchApi = useDaemonApi()
  const [state, setState] = useState<CardState>({ kind: 'loading' })
  const [status, setStatus] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [pendingRemoval, setPendingRemoval] = useState<{
    profileId: string
    displayName: string
  } | null>(null)
  // A changed fetchApi identity means a different daemon connection: a slow
  // response from the previous one must not land on this one's list.
  const generationRef = useRef(0)
  const headingRef = useRef<HTMLHeadingElement>(null)
  // The row button that opened the dialog. One AlertDialog is shared by
  // every row (it lives outside the list, so it can show its own AlertDialog
  // regardless of which row asked), so Radix's own trigger tracking
  // (`AlertDialogTrigger`) does not apply here — this plays that role by
  // hand: focus returns to the button that opened the dialog unless the
  // removal actually succeeded, in which case that button no longer exists.
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const justRemovedRef = useRef(false)
  const selectId = useId()
  const nameId = useId()

  const load = useCallback(
    async (options?: { generation?: number }) => {
      // A refresh after a successful mutation (handleAddSubmit's post-add
      // reload) reuses the caller's own generation instead of minting a new
      // one: minting one here would read as a daemon-identity change and
      // silently invalidate an unrelated in-flight request — e.g. a member
      // removal confirmed while an add was still in flight, whose success
      // would then fail the generation check for a removal the server had
      // genuinely completed.
      const generation = options?.generation ?? ++generationRef.current
      setState({ kind: 'loading' })

      const members = await readCurrent(
        fetchApi,
        membersUrl(workspaceId),
        listMembersResponseSchema,
        generation,
        generationRef,
      )
      if (members.kind === 'stale') return
      if (members.kind === 'error') {
        setState({ kind: 'error' })
        return
      }

      const pins = await readCurrent(
        fetchApi,
        '/api/pairing/credentials',
        listCredentialsResponseSchema,
        generation,
        generationRef,
      )
      if (pins.kind === 'stale') return
      if (pins.kind === 'error') {
        setState({ kind: 'error' })
        return
      }

      setState({ kind: 'loaded', members: members.value.members, pins: pins.value.credentials })
    },
    [fetchApi, workspaceId],
  )

  useEffect(() => {
    void load()
  }, [load])

  async function handleAddSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (state.kind !== 'loaded') return
    const form = event.currentTarget
    const request = addMemberRequest(new FormData(form), state.pins)
    if (request === null) return

    const generation = generationRef.current
    setAdding(true)
    setAddError(null)
    try {
      const added = await postMember(fetchApi, workspaceId, request, generation, generationRef)
      if (added.kind === 'stale') return
      if (added.kind === 'error') {
        setAddError(added.message)
        return
      }
      form.reset()
      setStatus(`${added.value.displayName} was added.`)
      // The caller's own generation, not a fresh one: minting one here would
      // read as a daemon-identity change and invalidate an unrelated
      // in-flight request — see `load`.
      await load({ generation })
    } catch {
      if (generation !== generationRef.current) return
      setAddError('Request failed.')
    } finally {
      setAdding(false)
    }
  }

  async function confirmRemoval(member: { profileId: string; displayName: string }) {
    const generation = generationRef.current
    setRemoving(true)
    try {
      const res = await fetchApi(
        `${membersUrl(workspaceId)}/${encodeURIComponent(member.profileId)}`,
        {
          method: 'DELETE',
        },
      )
      if (generation !== generationRef.current) return
      if (!res.ok) {
        setStatus(
          apiErrorReason(await res.json().catch(() => undefined)) ??
            `Request failed (${res.status}).`,
        )
        return
      }
      const parsed = removeMemberResponseSchema.safeParse(await res.json())
      if (generation !== generationRef.current) return
      if (parsed.success && parsed.data.removed) {
        setState((current) =>
          current.kind === 'loaded'
            ? {
                ...current,
                members: current.members.filter((m) => m.profileId !== member.profileId),
              }
            : current,
        )
        setStatus(`${member.displayName} was removed.`)
        justRemovedRef.current = true
      } else {
        setStatus(`Request failed (${res.status}).`)
      }
    } catch {
      if (generation !== generationRef.current) return
      setStatus('Request failed.')
    } finally {
      setRemoving(false)
      setPendingRemoval(null)
    }
  }

  return (
    <section data-testid="members-card" className="rounded-lg border p-4">
      <h2 ref={headingRef} tabIndex={-1} className="mb-1 text-sm font-semibold outline-none">
        Members
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Who this workspace lets in. Adding someone turns a passkey pinned on this daemon into a
        person with access; removing them ends that access now.
      </p>

      {/* Mounted before it speaks (polite-live-region.test.ts): a status
          region that arrives with its message is announced inconsistently. */}
      <p
        role="status"
        aria-live="polite"
        data-testid="members-status"
        className={status === null ? 'sr-only' : 'mb-2 text-xs'}
      >
        {status ?? ''}
      </p>

      {state.kind === 'loading' && (
        <SquiggleLoader label="Loading…" className="justify-start text-xs" />
      )}
      {state.kind === 'error' && (
        <p className="text-xs text-muted-foreground">
          Could not load the members of this workspace.
        </p>
      )}
      {state.kind === 'loaded' && (
        <>
          {state.members.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No one has been added to this workspace yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {state.members.map((member) => (
                <li
                  key={member.profileId}
                  data-testid={`member-${member.profileId}`}
                  className="flex items-start justify-between gap-2 text-xs"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{member.displayName}</p>
                    <p className="break-all text-muted-foreground">
                      {[...new Set(member.credentials.map((c) => c.origin))].join(', ')}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${member.displayName} from this workspace`}
                    onClick={(event) => {
                      triggerRef.current = event.currentTarget
                      setPendingRemoval({
                        profileId: member.profileId,
                        displayName: member.displayName,
                      })
                    }}
                    className="shrink-0 rounded-md border px-2 py-0.5 font-medium text-destructive transition-colors hover:bg-destructive/10"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          {state.pins.length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Register a passkey under Connections › Passkeys first; a member is added by choosing
              one.
            </p>
          ) : (
            <form onSubmit={(event) => void handleAddSubmit(event)} className="mt-3 space-y-2">
              {addError !== null && (
                <p role="alert" className="text-xs text-destructive">
                  {addError}
                </p>
              )}
              <div className="flex flex-col gap-1">
                <label htmlFor={selectId} className="text-xs text-muted-foreground">
                  Passkey
                </label>
                <select
                  id={selectId}
                  name="credentialIndex"
                  defaultValue="0"
                  className="rounded-md border px-2 py-1 text-xs"
                >
                  {state.pins.map((pin, index) => (
                    <option key={pin.credentialId} value={index}>
                      {pin.origin} · {pin.credentialId.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={nameId} className="text-xs text-muted-foreground">
                  Name
                </label>
                <input
                  id={nameId}
                  name="displayName"
                  maxLength={120}
                  required
                  className="rounded-md border px-2 py-1 text-xs"
                />
              </div>
              <Button type="submit" size="sm" disabled={adding}>
                Add
              </Button>
            </form>
          )}
        </>
      )}

      <AlertDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open && removing) return
          if (!open) setPendingRemoval(null)
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (justRemovedRef.current) {
              justRemovedRef.current = false
              headingRef.current?.focus()
            } else {
              triggerRef.current?.focus()
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingRemoval === null ? 'Remove member?' : `Remove ${pendingRemoval.displayName}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {DESTRUCTIVE_COPY['remove-member'](pendingRemoval?.displayName ?? '')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            {/* Not AlertDialogAction: it closes on click, but the dialog must
                stay open (pinned) until the async delete settles. */}
            <Button
              type="button"
              variant="destructive"
              disabled={removing}
              onClick={() => {
                if (pendingRemoval !== null) void confirmRemoval(pendingRemoval)
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
