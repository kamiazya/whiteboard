import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import { useDaemonApi } from '@/contexts/DaemonApiContext'

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

  const load = useCallback(async () => {
    try {
      const res = await fetchApi('/api/pairing/grants')
      if (!res.ok) {
        setState({ kind: 'error' })
        return
      }
      const parsed = listGrantsResponseSchema.safeParse(await res.json())
      if (!parsed.success) {
        setState({ kind: 'error' })
        return
      }
      setState({ kind: 'loaded', grants: parsed.data.grants })
    } catch {
      setState({ kind: 'error' })
    }
  }, [fetchApi])

  useEffect(() => {
    void load()
  }, [load])

  async function revoke(grant: PairedGrant) {
    setRevokeError(null)
    try {
      const res = await fetchApi(`/api/pairing/grants/${encodeURIComponent(grant.grantId)}`, {
        method: 'DELETE',
      })
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
      setRevokeError(`Could not revoke ${grant.origin}.`)
    }
  }

  return (
    <section data-testid="paired-origins-card" className="rounded-lg border p-4">
      <h2 className="mb-1 text-sm font-semibold">Paired web apps</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Web apps you approved on this daemon's consent page. Revoking cuts their access immediately,
        including any active session.
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
