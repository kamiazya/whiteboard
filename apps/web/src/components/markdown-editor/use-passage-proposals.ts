/**
 * The proposal layer's half of the source pane, held apart from the editor
 * that mounts it.
 *
 * Four things that only make sense together, which is why they are one hook
 * rather than four members of an already-long component: the extension the
 * view is built with, the projection effect that feeds it, which passage the
 * person has open, and where that passage currently sits.
 */
import type { Extension } from '@codemirror/state'
import type { Proposal } from '@kamiazya/whiteboard-model'
import { type RefObject, useEffect, useMemo, useState } from 'react'
import {
  type PlacedPassage,
  placePassages,
  proposalDecorations,
  setProposalProjection,
} from './proposal-decorations.js'

/** Where the card sits, in the editor root's own coordinates. */
export interface OpenPassage {
  readonly proposalId: string
  readonly changeId: string
  readonly x: number
  readonly y: number
}

export interface PassageProposals {
  /** Added to the source pane's extensions; static, so the view keeps it. */
  readonly extension: Extension
  readonly open: OpenPassage | null
  /** Where the open passage is right now, or null when it has none. */
  readonly placed: PlacedPassage | null
  readonly close: () => void
}

export interface PassageProposalsHost {
  /** The body as the pane currently holds it. */
  readonly value: string
  readonly proposals: readonly Proposal[]
  /** Applies CodeMirror effects to the live view. */
  readonly applyEffects: (effects: readonly ReturnType<typeof setProposalProjection.of>[]) => void
  /** The element a card's coordinates are relative to. */
  readonly rootRef: RefObject<HTMLElement | null>
}

export function usePassageProposals(host: PassageProposalsHost): PassageProposals {
  const { value, proposals, applyEffects, rootRef } = host
  const [open, setOpen] = useState<OpenPassage | null>(null)

  const extension = useMemo(
    () =>
      proposalDecorations({
        onSelectPassage: (proposalId, changeId, at) => {
          const rect = rootRef.current?.getBoundingClientRect()
          setOpen({
            proposalId,
            changeId,
            x: at.clientX - (rect?.left ?? 0),
            y: at.clientY - (rect?.top ?? 0),
          })
        },
      }),
    [rootRef],
  )

  useEffect(() => {
    applyEffects([
      setProposalProjection.of({ proposals, selectedChangeId: open?.changeId ?? null }),
    ])
  }, [proposals, open, applyEffects])

  // The card follows the DOCUMENT, not the press: once the passage it is
  // about stops resolving — the person adopted it, dismissed it, or edited
  // the words out from under it — there is nothing left to decide, and a
  // card still offering the verbs would write against a passage that is
  // gone.
  const placed = useMemo(() => {
    if (open === null) return null
    return placePassages(value, proposals).find((one) => one.changeId === open.changeId) ?? null
  }, [open, proposals, value])
  useEffect(() => {
    if (open !== null && placed === null) setOpen(null)
  }, [open, placed])

  return useMemo(
    () => ({ extension, open, placed, close: () => setOpen(null) }),
    [extension, open, placed],
  )
}
