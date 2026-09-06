import type { BranchMeta } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { BranchesBackend } from '../lib/branches-backend.js'
import type { PastDocument } from '../lib/versions-backend.js'

/**
 * ADR-0022's `?v=`: looking at a variation WITHOUT switching onto it.
 *
 * Keeper-agnostic by construction — it reads the branches seam, the address,
 * and a refresh signal, none of which is a keeper's business. It lived on the
 * daemon page from when variations were a daemon concept, which is why a
 * browser-kept variation could be switched and combined but not linked to.
 * It belongs to the page both keepers render through.
 */
export interface VariationPreview {
  readonly name: string
  readonly head: string
  readonly branches: readonly BranchMeta[]
  readonly past: PastDocument
}

export interface UseVariationPreviewResult {
  /** The variation being looked at, or null when the address names none. */
  readonly preview: VariationPreview | null
  /** Why a preview could not be shown. Every value here reports a failure. */
  readonly notice: string | null
  readonly dismissNotice: () => void
  /** Put a name in the address — what the chip's preview control calls. */
  readonly previewVariation: (name: string) => void
  /** Back to the live document, stripping the param. */
  readonly exitPreview: () => void
  /** Move HEAD onto what is being looked at. */
  readonly switchToPreviewed: () => void
}

export function useVariationPreview(deps: {
  readonly workspaceId: string | null
  readonly path: string | null
  readonly branches: BranchesBackend
  readonly refreshSignal?: number
  /**
   * HEAD moved because the banner's switch moved it. The keeper's own
   * `refreshSignal` reports a change it OBSERVED, and it cannot observe this
   * one — so without this the chip goes on naming the variation you just
   * left.
   */
  readonly onHeadChanged?: () => void
}): UseVariationPreviewResult {
  const { workspaceId, path, branches, refreshSignal, onHeadChanged } = deps
  const [searchParams, setSearchParams] = useSearchParams()
  const variationParam = searchParams.get('v')
  const [variationPreview, setVariationPreview] = useState<VariationPreview | null>(null)
  const [variationNotice, setVariationNotice] = useState<string | null>(null)

  const clearVariationParam = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('v')
        return next
      },
      { replace: true },
    )
  }, [setSearchParams])

  const previewVariation = useCallback(
    (name: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set('v', name)
        return next
      })
    },
    [setSearchParams],
  )

  /**
   * The address survives a failed read, and that is the whole reason a
   * browser-kept variation can be linked to.
   *
   * A keeper answers this seam before it can: the browser's backend exists
   * from the moment the page has a document id, while the record behind it
   * arrives later, and until it does `list` answers the resting state —
   * `main` alone. Measured at mount with `?v=idea` on a document that has
   * `idea`: `{hasBranches: true, names: ['main']}`. Clearing the param on
   * that answer destroyed the request before the record could satisfy it,
   * and the retry (the refresh signal below) then had nothing to re-read.
   *
   * So a failure reports itself and leaves the address alone — every read
   * here is provisional, and the one that finally succeeds corrects the
   * notice. What the address means does not depend on which keeper is
   * slow.
   */
  useEffect(() => {
    if (workspaceId === null || path === null || variationParam === null) {
      setVariationPreview(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const state = await branches.list(workspaceId, path)
        if (cancelled) return
        // The default variation is never decorated, and neither is the one you
        // are already on — both strip back to the plain address (ADR-0022).
        if (variationParam === 'main' || variationParam === state.head) {
          clearVariationParam()
          return
        }
        if (!state.branches.some((b) => b.name === variationParam)) {
          setVariationNotice(`Variation «${variationParam}» was not found`)
          setVariationPreview(null)
          return
        }
        const past = await branches.loadDocument(workspaceId, path, variationParam)
        if (cancelled) return
        if (past === null) {
          setVariationNotice(`Variation «${variationParam}» could not be read`)
          setVariationPreview(null)
          return
        }
        setVariationNotice(null)
        setVariationPreview({ name: variationParam, head: state.head, branches: state.branches, past })
      } catch {
        if (!cancelled) {
          setVariationNotice('Variation preview failed to load')
          setVariationPreview(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // refreshSignal: an external HEAD change can make the previewed name the
    // HEAD, which must strip the param rather than keep a stale "read-only"
    // claim over what is now the live document.
  }, [workspaceId, path, variationParam, branches, clearVariationParam, refreshSignal])

  /**
   * A variation name qualifies ONE document, so arriving at a different one
   * leaves it naming nothing — and a notice earned on the document you have
   * left reads as being about the one in front of you (the same class as a
   * dialog outliving its subject; `DaemonDocumentPage.surface-outlives-
   * document.test.tsx`).
   *
   * The first path this hook sees is not a switch, which is why the previous
   * one is remembered rather than inferred from `null`.
   */
  const lastPathRef = useRef<string | null>(null)
  // SCOPE RESET — see scoped-screen-state.test.ts.
  useEffect(() => {
    const previous = lastPathRef.current
    lastPathRef.current = path
    if (previous === null || path === null || previous === path) return
    setVariationNotice(null)
    setVariationPreview(null)
    clearVariationParam()
  }, [path, clearVariationParam])

  const switchToPreviewed = useCallback(() => {
    if (workspaceId === null || path === null || variationPreview === null) return
    void (async () => {
      try {
        await branches.setHead(workspaceId, path, variationPreview.name)
        onHeadChanged?.()
        clearVariationParam()
      } catch {
        setVariationNotice('Switching to this variation failed')
      }
    })()
  }, [workspaceId, path, variationPreview, branches, clearVariationParam, onHeadChanged])

  return {
    preview: variationPreview,
    notice: variationNotice,
    dismissNotice: useCallback(() => setVariationNotice(null), []),
    previewVariation,
    exitPreview: clearVariationParam,
    switchToPreviewed,
  }
}
