import {
  apiErrorReason,
  listCredentialsResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { memberProfileSummarySchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import { useEffect, useId, useState } from 'react'
import type { z } from 'zod'
import { useDaemonApi } from '../../contexts/DaemonApiContext.js'
import { WorkspacePeopleList } from '../people/WorkspacePeopleList.js'
import { Button } from '../ui/button.js'

type Fetch = typeof globalThis.fetch
type PinnedPasskey = z.infer<typeof listCredentialsResponseSchema>['credentials'][number]

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

/** The passkeys pinned on this daemon; `null` while read, `'error'` if not. */
function usePins(fetchApi: Fetch): readonly PinnedPasskey[] | null | 'error' {
  const [pins, setPins] = useState<readonly PinnedPasskey[] | null | 'error'>(null)
  useEffect(() => {
    // A different daemon connection makes an answer from the previous one
    // nobody's.
    let live = true
    void fetchApi('/api/pairing/credentials')
      .then(async (res) => {
        const parsed = listCredentialsResponseSchema.safeParse(await res.json())
        return res.ok && parsed.success ? parsed.data.credentials : 'error'
      })
      .catch(() => 'error' as const)
      .then((value) => {
        if (live) setPins(value)
      })
    return () => {
      live = false
    }
  }, [fetchApi])
  return pins
}

/** Posting a passkey as a member, with what happened to say afterwards. */
function useAddPasskeyMember(fetchApi: Fetch, workspaceId: string, onAdded: () => void) {
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<string | null>(null)
  async function submit(form: HTMLFormElement, pins: readonly PinnedPasskey[]) {
    const request = addMemberRequest(new FormData(form), pins)
    if (request === null) return
    setAdding(true)
    setError(null)
    try {
      const res = await fetchApi(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
      const body: unknown = await res.json().catch(() => undefined)
      const parsed = memberProfileSummarySchema.safeParse(body)
      if (!res.ok || !parsed.success) {
        setError(apiErrorReason(body) ?? `Request failed (${res.status}).`)
        return
      }
      form.reset()
      setAdded(`${parsed.data.displayName} was added.`)
      onAdded()
    } catch {
      setError('Request failed.')
    } finally {
      setAdding(false)
    }
  }
  return { adding, error, added, submit }
}

function PasskeyFields({ pins }: { pins: readonly PinnedPasskey[] }) {
  const selectId = useId()
  const nameId = useId()
  return (
    <>
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
          {pins.map((pin, index) => (
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
    </>
  )
}

/**
 * How a person joins a workspace on the local daemon (ADR-0049 decision 5):
 * a passkey pinned on this daemon, named. The rest of the people surface is
 * the one both keepers share.
 */
function AddPasskeyMember({
  fetchApi,
  workspaceId,
  onAdded,
}: {
  fetchApi: Fetch
  workspaceId: string
  onAdded: () => void
}) {
  const pins = usePins(fetchApi)
  const { adding, error, added, submit } = useAddPasskeyMember(fetchApi, workspaceId, onAdded)
  if (pins === null) return null
  if (pins === 'error') {
    return <p className="text-xs text-muted-foreground">Could not read this daemon's passkeys.</p>
  }
  if (pins.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Register a passkey under Connections › Passkeys first; a member is added by choosing one.
      </p>
    )
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void submit(event.currentTarget, pins)
      }}
      className="space-y-2"
    >
      <p role="status" aria-live="polite" className={added === null ? 'sr-only' : 'text-xs'}>
        {added ?? ''}
      </p>
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <PasskeyFields pins={pins} />
      <Button type="submit" size="sm" disabled={adding}>
        Add
      </Button>
    </form>
  )
}

/**
 * Settings > Connections' "This workspace" members: the people a daemon
 * workspace admits (ADR-0041 L1), listed and changed through the same
 * people surface a server-mode keeper serves (ADR-0049 decision 5), with a
 * pinned passkey as the local way in.
 */
export function MembersCard({ workspaceId }: { workspaceId: string }) {
  const fetchApi = useDaemonApi()
  const [reloadKey, setReloadKey] = useState(0)
  return (
    <section data-testid="members-card" className="rounded-lg border p-4">
      <h2 className="mb-1 text-sm font-semibold">Members</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Who this workspace lets in. Adding someone turns a passkey pinned on this daemon into a
        person with access; removing them ends that access now.
      </p>
      <WorkspacePeopleList
        fetchFn={fetchApi}
        workspaceId={workspaceId}
        reloadKey={reloadKey}
        adding={
          <AddPasskeyMember
            fetchApi={fetchApi}
            workspaceId={workspaceId}
            onAdded={() => setReloadKey((key) => key + 1)}
          />
        }
      />
    </section>
  )
}
