/**
 * Who proposed a batch of changes, said the same way wherever a proposal is
 * shown — the Proposals panel row and both in-place decision cards.
 *
 * The name alone would read as a verb or a node beside the lines around it;
 * `okfActor` carries no human-vs-agent kind to badge, so the word "by" is all
 * this can honestly add. Provenance is optional (a browser-kept workspace has
 * nobody to name), and an absent author draws nothing rather than a blank
 * line.
 */
import type { Proposal } from '@kamiazya/whiteboard-model'

export function ProposalAuthor({
  author,
  className,
}: {
  readonly author: Proposal['author']
  readonly className?: string
}) {
  return author === undefined ? null : <span className={className}>by {author}</span>
}
