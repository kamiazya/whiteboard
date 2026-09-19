import { listCredentialsResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { useDaemonApi } from '../contexts/DaemonApiContext.js'
import {
  forgetRegisteredPasskey,
  getRegisteredPasskey,
  type PasskeyCredentials,
  passkeySupported,
  registerPasskey,
} from '../lib/passkey-attestation.js'
import { SquiggleLoader } from './SquiggleLoader.js'

type PinnedPasskey = z.infer<typeof listCredentialsResponseSchema>['credentials'][number]

type CardState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'loaded'; passkeys: readonly PinnedPasskey[] }

/**
 * The passkeys this daemon will accept a move from, with register and remove.
 *
 * Every pin the daemon holds is listed, not only this browser's: the daemon
 * is the thing being managed, and a pin planted from another browser or
 * another origin is exactly what a person would come here to find. The one
 * this browser will actually use is marked, because that is the question the
 * move dialog raises and this card answers.
 */
export function PasskeysCard({
  daemonBaseUrl,
  // `null` states the seam explicitly: no passkeys here. Undefined asks the
  // page, which is what a real browser does — the same shape
  // PromoteWorkspaceSection takes, so a test drives both the same way.
  passkeyCredentials,
}: {
  daemonBaseUrl: string
  passkeyCredentials?: PasskeyCredentials | null
}) {
  const fetchApi = useDaemonApi()
  const [state, setState] = useState<CardState>({ kind: 'loading' })
  const [status, setStatus] = useState<string | null>(null)
  const [registering, setRegistering] = useState(false)
  // A changed fetchApi identity means a DIFFERENT daemon: a slow response
  // from the previous one must not land on this one's list, whose pins are
  // another daemon's entirely.
  const generationRef = useRef(0)

  const credentials = (): PasskeyCredentials | undefined => {
    if (passkeyCredentials === null) return undefined
    if (passkeyCredentials !== undefined) return passkeyCredentials
    return passkeySupported() ? globalThis.navigator.credentials : undefined
  }
  const supported = credentials() !== undefined

  const load = useCallback(async () => {
    const generation = ++generationRef.current
    setState({ kind: 'loading' })
    try {
      const res = await fetchApi('/api/pairing/credentials')
      if (generation !== generationRef.current) return
      if (!res.ok) {
        setState({ kind: 'error' })
        return
      }
      const parsed = listCredentialsResponseSchema.safeParse(await res.json())
      if (generation !== generationRef.current) return
      setState(
        parsed.success ? { kind: 'loaded', passkeys: parsed.data.credentials } : { kind: 'error' },
      )
    } catch {
      if (generation !== generationRef.current) return
      setState({ kind: 'error' })
    }
  }, [fetchApi])

  useEffect(() => {
    void load()
  }, [load])

  const registeredHere = getRegisteredPasskey(daemonBaseUrl)?.credentialId

  async function register() {
    const platform = credentials()
    if (platform === undefined) return
    setRegistering(true)
    setStatus(null)
    const result = await registerPasskey({ daemonBaseUrl, fetch: fetchApi, credentials: platform })
    setRegistering(false)
    if (result.ok) {
      setStatus('Registered. This browser will confirm moves with it.')
      await load()
      return
    }
    setStatus(
      result.reason === 'cancelled'
        ? 'The passkey prompt was cancelled, so nothing was registered.'
        : `Could not register a passkey: ${result.detail ?? result.reason}.`,
    )
  }

  async function revoke(passkey: PinnedPasskey) {
    const generation = generationRef.current
    setStatus(null)
    try {
      const res = await fetchApi(
        `/api/pairing/credentials/${encodeURIComponent(passkey.credentialId)}`,
        { method: 'DELETE' },
      )
      if (generation !== generationRef.current) return
      if (!res.ok) {
        setStatus(`Could not remove the passkey registered from ${passkey.origin}.`)
        return
      }
      // The browser must stop naming a pin the daemon no longer holds, or the
      // next move is refused for something the person just did on purpose.
      if (passkey.credentialId === registeredHere) forgetRegisteredPasskey(daemonBaseUrl)
      setState((current) =>
        current.kind === 'loaded'
          ? {
              kind: 'loaded',
              passkeys: current.passkeys.filter((p) => p.credentialId !== passkey.credentialId),
            }
          : current,
      )
    } catch {
      if (generation !== generationRef.current) return
      setStatus(`Could not remove the passkey registered from ${passkey.origin}.`)
    }
  }

  return (
    <section data-testid="passkeys-card" className="rounded-lg border p-4">
      <h2 className="mb-1 text-sm font-semibold">Passkeys</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        A passkey confirms that you, and not something running in the page, moved this workspace
        here. Removing one does not change history: moves you already confirmed stay verified, and a
        new passkey confirms the next ones.
      </p>

      {/* Mounted before it speaks (polite-live-region.test.ts): a status
          region that arrives with its message is announced inconsistently. */}
      <p
        role="status"
        aria-live="polite"
        data-testid="passkeys-status"
        className={status === null && !registering ? 'sr-only' : 'mb-2 text-xs'}
      >
        {registering ? 'Waiting for your passkey…' : (status ?? '')}
      </p>

      {state.kind === 'loading' && (
        <SquiggleLoader label="Loading…" className="justify-start text-xs" />
      )}
      {state.kind === 'error' && (
        <p className="text-xs text-muted-foreground">Could not load this daemon's passkeys.</p>
      )}
      {state.kind === 'loaded' && (
        <>
          {state.passkeys.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No passkey is registered on this daemon yet. Without one, a move here is recorded
              without proof that a person made it.
            </p>
          ) : (
            <ul className="space-y-2">
              {state.passkeys.map((passkey) => (
                <li
                  key={passkey.credentialId}
                  data-testid={`passkey-${passkey.credentialId}`}
                  className="flex items-start justify-between gap-2 text-xs"
                >
                  <div className="min-w-0">
                    <p className="break-all font-mono">{passkey.origin}</p>
                    <p className="text-muted-foreground">
                      {passkey.backupEligible
                        ? 'Synced across your devices'
                        : 'Only on this device'}
                      {passkey.credentialId === registeredHere && ' · used by this browser'}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove the passkey registered from ${passkey.origin}`}
                    onClick={() => void revoke(passkey)}
                    className="shrink-0 rounded-md border px-2 py-0.5 font-medium text-destructive transition-colors hover:bg-destructive/10"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {supported ? (
            <button
              type="button"
              data-testid="passkeys-register"
              disabled={registering}
              onClick={() => void register()}
              className="mt-3 rounded-md border px-2 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
            >
              Register a passkey
            </button>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              This browser cannot use passkeys, so a move from here is recorded without one.
            </p>
          )}
        </>
      )}
    </section>
  )
}
