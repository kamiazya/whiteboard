/**
 * Object URLs for the stored pictures a render needs, loaded once and revoked
 * together.
 *
 * Extracted rather than copied, for the reason `use-document-file-seams`'s own
 * header gives about the caching rules it holds: there are two surfaces now —
 * the board and the markdown preview — and the subtleties here each exist
 * because of a defect. A load that answers nothing must return the SAME map
 * instance, or the fresh (equal) map republishes state, re-runs this effect
 * and spins the read forever. An asset is immutable once stored, so a hit is
 * never invalidated; the URLs are revoked on unmount, since leaking them keeps
 * the decoded image alive for the tab's lifetime.
 *
 * The two non-answers are the loader contract's (`DocumentFileAdapter`):
 * `undefined` is "no such picture" and is never asked again, while a
 * rejection is a failed read, asked again up to `TRANSIENT_LOAD_ATTEMPTS`
 * times. Waiting for the refs to change instead left the picture on its card
 * for the life of the page, since an open board's pictures do not change on
 * their own; the bound is what keeps a read that always fails from spinning.
 */
import { useEffect, useRef, useState } from 'react'
import { TRANSIENT_LOAD_ATTEMPTS } from './use-prefetched-cache.js'

export type LoadImageUrl = (ref: string) => Promise<string | undefined>

type Outcome =
  | { readonly ref: string; readonly kind: 'url'; readonly url: string }
  | { readonly ref: string; readonly kind: 'absent' | 'failed' }
type Installed = Extract<Outcome, { kind: 'url' }>

export function useImageUrls(
  refs: readonly string[],
  load: LoadImageUrl | undefined,
): ReadonlyMap<string, string> {
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map())
  const urlsRef = useRef<ReadonlyMap<string, string>>(urls)
  urlsRef.current = urls
  // What a ref settled to short of a URL: absent, or how many reads failed.
  const settled = useRef<Settled>(new Map())
  // Bumped when a failed read has an attempt left, which is what re-runs the
  // effect for refs that have not changed.
  const [round, setRound] = useState(0)

  // Kept in a ref so a caller that rebuilds its loader every render cannot
  // restart the fetch; a loader is a backend binding, not reactive state.
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(
    () => () => {
      for (const url of urlsRef.current.values()) URL.revokeObjectURL(url)
    },
    [],
  )

  // An array identity changes every render, so the effect keys on the CONTENT.
  // The refs are asset ids, which cannot hold a newline.
  const key = refs.join('\n')
  useEffect(() => {
    const loader = loadRef.current
    if (loader === undefined) return
    const wanted =
      key === ''
        ? []
        : key.split('\n').filter((ref) => isWanted(ref, urlsRef.current, settled.current))
    if (wanted.length === 0) return
    let cancelled = false
    // SETTLED, not `Promise.all`: a loader is a backend binding this hook does
    // not own, and one rejection took the whole batch down — installing none
    // of the URLs that had loaded, and going unhandled besides.
    void Promise.all(wanted.map((ref) => outcomeOf(loader, ref))).then((loaded) => {
      if (cancelled) {
        // A URL minted after cleanup is in nobody's map, so the unmount
        // revoke below can never reach it. Dropping it leaks the decoded
        // image for the tab's lifetime.
        for (const outcome of loaded) if (outcome.kind === 'url') URL.revokeObjectURL(outcome.url)
        return
      }
      recordSettled(settled.current, loaded)
      setUrls((prev) => withUrls(prev, loaded))
      // `isWanted` is the one place the bound lives, so a read that always
      // fails stops being asked for after its last attempt.
      const retry = loaded.some(
        (outcome) =>
          outcome.kind === 'failed' && isWanted(outcome.ref, urlsRef.current, settled.current),
      )
      if (retry) setRound((n) => n + 1)
    })
    return () => {
      cancelled = true
    }
  }, [key, round])

  return urls
}

type Settled = Map<string, 'absent' | number>

function isWanted(ref: string, urls: ReadonlyMap<string, string>, settled: Settled): boolean {
  if (urls.has(ref)) return false
  const state = settled.get(ref)
  return state === undefined || (state !== 'absent' && state < TRANSIENT_LOAD_ATTEMPTS)
}

/** Records what a batch settled to short of a URL. */
function recordSettled(settled: Settled, loaded: readonly Outcome[]): void {
  for (const outcome of loaded) {
    if (outcome.kind === 'absent') settled.set(outcome.ref, 'absent')
    if (outcome.kind !== 'failed') continue
    const previous = settled.get(outcome.ref)
    settled.set(outcome.ref, (typeof previous === 'number' ? previous : 0) + 1)
  }
}

/** `prev` itself when nothing installed, so a batch of non-answers republishes nothing. */
function withUrls(
  prev: ReadonlyMap<string, string>,
  loaded: readonly Outcome[],
): ReadonlyMap<string, string> {
  const installed = loaded.filter((outcome): outcome is Installed => outcome.kind === 'url')
  if (installed.length === 0) return prev
  const next = new Map(prev)
  for (const outcome of installed) next.set(outcome.ref, outcome.url)
  return next
}

async function outcomeOf(loader: LoadImageUrl, ref: string): Promise<Outcome> {
  try {
    const url = await loader(ref)
    return url === undefined ? { ref, kind: 'absent' } : { ref, kind: 'url', url }
  } catch {
    return { ref, kind: 'failed' }
  }
}
