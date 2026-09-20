import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { useCallback, useState } from 'react'

/**
 * A write that SUCCEEDED but whose list re-read did not.
 *
 * Separate from the refusal states because the two need opposite things: a
 * refusal invites another attempt, this one must not — pressing again would
 * create a second document, or toggle the pin straight back off.
 *
 * Carries the action because the verb is the whole message: "Created" and
 * "Pinned" tell the person a different thing about what is now true.
 */
export interface StaleListNotice {
  readonly action: 'created' | 'pinned' | 'unpinned'
  readonly path: string
}

/**
 * A refused pin, as the direction that was asked for and the source's own
 * reason. Only the store knows why it said no — that a workspace is
 * read-only, say — and a pin is the one verb on the card menu with no form of
 * its own to report into.
 */
export interface PinRefusal {
  readonly pinning: boolean
  readonly path: string
  readonly reason: string
}

/**
 * A refused create, as the kind that was asked for and the reason given.
 *
 * The reason is the source's own words — the same treatment a refused MOVE
 * already gets, and for the same purpose: only the store knows which path
 * actually collided, and an address the message will not name cannot be
 * corrected.
 *
 * The dialog renders `reason` too, so both are in the DOM while it is open.
 * Only one is ANNOUNCED — Radix marks the page behind a modal `aria-hidden`
 * (measured: DOM 2, accessible 1) — and dismissing the form clears this, so
 * the panel's generic line never outlives the submission it describes. That
 * is why there is no "which surface asked" flag here: it would be a second
 * rule for an outcome the clearing already produces, and no test could tell
 * the two apart.
 */
export interface CreateRefusal {
  readonly kind: DocumentKind
  readonly reason: string
}

/**
 * What the panel has to SAY about its last write, and the one rule that
 * governs all three: a new attempt clears every one of them first.
 *
 * They stay three independent values rather than one union because they are
 * three different statements — a create was refused, a pin was refused, a
 * write landed but the list is stale — and a person can be owed more than
 * one. What they share is only the clearing, which is why `beginWrite` is
 * the hook's reason for existing: it was two identical three-line runs at
 * the top of `createHere` and `togglePinned`, and the failure mode is
 * silent, a banner outliving the attempt it describes.
 */
export interface WriteOutcome {
  readonly staleList: StaleListNotice | null
  readonly pinRefusal: PinRefusal | null
  readonly createRefusal: CreateRefusal | null
  /** Clears all three. Called at the top of every write, and on a scope change. */
  readonly beginWrite: () => void
  readonly reportStaleList: (notice: StaleListNotice) => void
  readonly reportPinRefusal: (refusal: PinRefusal) => void
  readonly reportCreateRefusal: (refusal: CreateRefusal) => void
  readonly dismissCreateRefusal: () => void
}

export function useWriteOutcome(): WriteOutcome {
  const [staleList, setStaleList] = useState<StaleListNotice | null>(null)
  const [pinRefusal, setPinRefusal] = useState<PinRefusal | null>(null)
  const [createRefusal, setCreateRefusal] = useState<CreateRefusal | null>(null)

  // SCOPE RESET — the panel's own scope-reset effect calls this; the marker
  // lets scoped-screen-state.test.ts verify the setters from here.
  const beginWrite = useCallback(() => {
    setStaleList(null)
    setPinRefusal(null)
    setCreateRefusal(null)
  }, [])

  return {
    staleList,
    pinRefusal,
    createRefusal,
    beginWrite,
    reportStaleList: setStaleList,
    reportPinRefusal: setPinRefusal,
    reportCreateRefusal: setCreateRefusal,
    dismissCreateRefusal: useCallback(() => setCreateRefusal(null), []),
  }
}
