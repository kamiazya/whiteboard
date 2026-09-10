import type { Proposal, ProposedChange } from '@kamiazya/whiteboard-model'

/**
 * Which proposals are still waiting on a person.
 *
 * A proposal carries no status of its own (ADR-0029): whether it is open
 * follows from its changes, because "nine of these are right and one is not"
 * is the common case and a per-batch verdict cannot say it. So one open
 * change keeps the batch open, and a batch every change of which is decided
 * is done — however it was decided, since an adopted change and a dismissed
 * one are both answered.
 *
 * Derived rather than stored for the reason the ADR gives: a second place to
 * write it leaves "which one counts?" unanswerable the moment the two
 * disagree.
 */
export function isOpenProposal(proposal: Proposal): boolean {
  return proposal.changes.some((change: ProposedChange) => change.status === 'open')
}

/** The open proposals, in the order they were given. */
export function openProposals(proposals: readonly Proposal[]): readonly Proposal[] {
  return proposals.filter(isOpenProposal)
}

/** How many changes in this proposal are still waiting — what a row says. */
export function openChangeCount(proposal: Proposal): number {
  return proposal.changes.filter((change: ProposedChange) => change.status === 'open').length
}
