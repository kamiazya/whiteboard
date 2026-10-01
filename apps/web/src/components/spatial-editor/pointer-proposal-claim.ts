import { clientPointToRootLocal, type Point } from '../../lib/spatial/viewport.js'
import { COMMENT_PRESS_SLOP_PX } from './pointer-comment-claim.js'
import type { EditorPointerInputs } from './pointer-inputs.js'

type ProposalClaimInputs = Pick<
  EditorPointerInputs,
  'hitTestProposal' | 'openProposalId' | 'pressedProposalRef' | 'setOpenProposalId'
>

/*
 * A proposal's part in a pointer gesture. Its BUBBLE is chrome above the
 * content, so a press on it opens the card at the release rather than
 * selecting whatever is under it. Its change OUTLINES are deliberately not
 * pressable: they are drawn where a change would land, and making them
 * pressable would put a dead zone over the node they describe.
 */

/** A press elsewhere on the surface shuts the open card, as it does a comment's. */
export function dismissProposalCard(c: ProposalClaimInputs, point: Point): void {
  if (c.openProposalId !== null && c.hitTestProposal(point) !== c.openProposalId) {
    c.setOpenProposalId(null)
  }
}

/** Whether the press landed on a bubble, remembering it for the release if so. */
export function claimProposalBubble(
  c: ProposalClaimInputs,
  point: Point,
  screenPoint: Point,
): boolean {
  const id = c.hitTestProposal(point)
  if (id === undefined) return false
  c.pressedProposalRef.current = { id, startScreen: screenPoint }
  return true
}

/**
 * The press, answered at the release — consumed whatever happens next, like
 * a comment's. One that travelled was a pan and opens nothing; one that
 * stayed put toggles the card, so pressing the bubble again is how it shuts.
 */
export function releaseProposalPress(
  c: ProposalClaimInputs,
  e: React.PointerEvent<HTMLDivElement>,
  root: HTMLElement,
): boolean {
  const pressed = c.pressedProposalRef.current
  c.pressedProposalRef.current = null
  if (pressed === null) return false
  const at = clientPointToRootLocal(e, root)
  const travelled = Math.hypot(at.x - pressed.startScreen.x, at.y - pressed.startScreen.y)
  if (travelled >= COMMENT_PRESS_SLOP_PX) return false
  c.setOpenProposalId((current) => (current === pressed.id ? null : pressed.id))
  return true
}

/** A cancelled press is spent, or the next unrelated release would open its card. */
export function cancelProposalPress(c: ProposalClaimInputs): void {
  c.pressedProposalRef.current = null
}
