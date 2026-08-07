import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { useDaemonApi } from '@/contexts/DaemonApiContext'
import { fingerprintPublicKey } from '@/lib/daemon-identity-pin'

// Mirrors the daemon's GET /api/pairing/grants response (see
// packages/mcp-server/src/server/routes/pairing.ts) — hydrated through the
// schema per zod-schema-discipline, never cast.
const listGrantsResponseSchema = z
  .object({
    grants: z.array(
      z.object({ grantId: z.string(), origin: z.string(), createdAt: z.string() }).strict(),
    ),
  })
  .strict()
type PairedGrant = z.infer<typeof listGrantsResponseSchema>['grants'][number]

type CardState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'loaded'; grants: readonly PairedGrant[] }

/**
 * Which web-app origins hold a pairing grant on this daemon, with revoke.
 * Revoking also kills the origin's live session tokens server-side, so the
 * revoked app loses access immediately, not at token expiry.
 */
export function PairedOriginsCard() {
  const fetchApi = useDaemonApi()
  const [state, setState] = useState<CardState>({ kind: 'loading' })
  const [revokeError, setRevokeError] = useState<string | null>(null)
  // A changed fetchApi identity means a DIFFERENT daemon: bump the
  // generation so a slow response (load or revoke) from the previous
  // daemon can never overwrite the active one's grants — its grantIds
  // belong to the other daemon entirely.
  const generationRef = useRef(0)
  const [fingerprint, setFingerprint] = useState<string | null>(null)

  // The daemon's identity fingerprint, so a user can cross-check the value
  // shown on the /pair consent page out-of-band. Best-effort: absent on
  // legacy daemons or while unreachable.
  useEffect(() => {
    const generation = generationRef.current
    let cancelled = false
    void (async () => {
      try {
        const res = await fetchApi('/api/runtime/ping')
        if (!res.ok) return
        const body = (await res.json()) as { identity?: { publicKey?: unknown } }
        const publicKey = body.identity?.publicKey
        if (typeof publicKey !== 'string' || publicKey.length === 0) return
        const value = await fingerprintPublicKey(publicKey)
        if (!cancelled && generation === generationRef.current) setFingerprint(value)
      } catch {
        // Leave the fingerprint absent.
      }
    })()
    return () => {
      cancelled = true
      setFingerprint(null)
    }
  }, [fetchApi])

  const load = useCallback(async () => {
    const generation = ++generationRef.current
    setState({ kind: 'loading' })
    setRevokeError(null)
    try {
      const res = await fetchApi('/api/pairing/grants')
      if (generation !== generationRef.current) return
      if (!res.ok) {
        setState({ kind: 'error' })
        return
      }
      const parsed = listGrantsResponseSchema.safeParse(await res.json())
      if (generation !== generationRef.current) return
      if (!parsed.success) {
        setState({ kind: 'error' })
        return
      }
      setState({ kind: 'loaded', grants: parsed.data.grants })
    } catch {
      if (generation !== generationRef.current) return
      setState({ kind: 'error' })
    }
  }, [fetchApi])

  useEffect(() => {
    void load()
  }, [load])

  async function revoke(grant: PairedGrant) {
    const generation = generationRef.current
    setRevokeError(null)
    try {
      const res = await fetchApi(`/api/pairing/grants/${encodeURIComponent(grant.grantId)}`, {
        method: 'DELETE',
      })
      if (generation !== generationRef.current) return
      if (!res.ok) {
        setRevokeError(`Could not revoke ${grant.origin}.`)
        return
      }
      setState((current) =>
        current.kind === 'loaded'
          ? { kind: 'loaded', grants: current.grants.filter((g) => g.grantId !== grant.grantId) }
          : current,
      )
    } catch {
      if (generation !== generationRef.current) return
      setRevokeError(`Could not revoke ${grant.origin}.`)
    }
  }

  return (
    <section data-testid="paired-origins-card" className="rounded-lg border p-4">
      <h2 className="mb-1 text-sm font-semibold">Paired web apps</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Web apps you approved on this daemon's consent page. Revoking cuts their access immediately,
        including any active session.
        {fingerprint !== null && (
          <>
            {' '}
            This daemon's identity:{' '}
            <span data-testid="daemon-fingerprint" className="font-mono">
              {fingerprint}
            </span>
            .
          </>
        )}
      </p>
      {revokeError && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {revokeError}
        </p>
      )}
      {state.kind === 'loading' && <p className="text-xs text-muted-foreground">Loading…</p>}
      {state.kind === 'error' && (
        <p className="text-xs text-muted-foreground">Could not load paired web apps.</p>
      )}
      {state.kind === 'loaded' &&
        (state.grants.length === 0 ? (
          <p className="text-xs text-muted-foreground">No web apps are paired.</p>
        ) : (
          <ul className="space-y-1.5">
            {state.grants.map((grant) => (
              <li key={grant.grantId} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-mono">{grant.origin}</span>
                <button
                  type="button"
                  aria-label={`Revoke ${grant.origin}`}
                  onClick={() => void revoke(grant)}
                  className="shrink-0 rounded-md border px-2 py-0.5 font-medium text-destructive transition-colors hover:bg-destructive/10"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        ))}
    </section>
  )
}
