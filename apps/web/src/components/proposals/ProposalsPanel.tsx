/**
 * The proposal layer's document-level surface (ADR-0029), standing in the
 * inspector's one slot beside the editor.
 *
 * It is an INDEX and deliberately nothing more. Decision 1 says a person is
 * never sent elsewhere to see what changed, so the place a change is decided
 * is the card drawn on the document itself — on the board for a canvas, in
 * the body for a passage. A panel that grew its own Adopt would be a second
 * place answering the same question, and the two would eventually disagree
 * about what "adopt" meant.
 *
 * What it is FOR is the thing the in-place surface cannot do: say how much is
 * waiting without hunting for it, and take you to one. Off-screen chrome is
 * the case that motivated it — a proposal on a node four thousand pixels away
 * is drawn correctly and seen by nobody.
 */

import type { Proposal, ProposedChange } from '@kamiazya/whiteboard-model'
import { openChangeCount, openProposals } from '../../lib/open-proposals.js'

/**
 * What each verb is called to a person. A closed record over the union, so a
 * new op cannot arrive without someone deciding how the index names it — the
 * op id is a wire spelling and reading `node.patch` in a panel is the surface
 * leaking its schema.
 */
const VERB_WORDS = {
  'node.add': 'Add a node',
  'node.patch': 'Move or restyle a node',
  'node.remove': 'Remove a node',
  'edge.add': 'Add a connection',
  'edge.patch': 'Restyle a connection',
  'edge.remove': 'Remove a connection',
  // "Line", not "connection": ink says nothing about what is related to what,
  // and the copy is where a reader learns the difference the split makes.
  'line.add': 'Draw a line',
  'line.patch': 'Redraw a line',
  'line.remove': 'Erase a line',
  'body.replace': 'Replace a passage',
} as const satisfies Record<ProposedChange['op'], string>

/** The distinct verbs still waiting, in the order they first appear. */
function waitingVerbs(proposal: Proposal): readonly string[] {
  const seen = new Set<string>()
  for (const change of proposal.changes) {
    if (change.status === 'open') seen.add(VERB_WORDS[change.op])
  }
  return [...seen]
}

export interface ProposalsPanelProps {
  readonly proposals: readonly Proposal[]
  /**
   * Reveals one proposal where it is drawn. Absent means this host has no
   * viewport to move — a markdown body draws its passages in place already,
   * so the index still counts them and simply has nowhere to send you.
   */
  readonly onOpen?: (proposalId: string) => void
}

export function ProposalsPanel({ proposals, onOpen }: ProposalsPanelProps) {
  const waiting = openProposals(proposals)
  return (
    <section aria-label="Proposals" className="px-3 py-2">
      <p className="text-muted-foreground mb-1 text-[11px] font-semibold uppercase tracking-wide">
        Waiting {waiting.length}
      </p>
      {waiting.length === 0 ? (
        <p className="text-muted-foreground py-2 text-sm">
          Nothing waiting — changes an agent proposes land here, and on the document itself.
        </p>
      ) : (
        <ul className="flex flex-col">
          {waiting.map((proposal) => (
            <li key={proposal.id}>
              <Row proposal={proposal} {...(onOpen === undefined ? {} : { onOpen })} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Row({
  proposal,
  onOpen,
}: {
  readonly proposal: Proposal
  readonly onOpen?: (proposalId: string) => void
}) {
  const open = openChangeCount(proposal)
  const body = (
    <>
      <span className="text-sm font-medium">
        {open} {open === 1 ? 'change' : 'changes'} waiting
      </span>
      {waitingVerbs(proposal)
        .slice(0, 2)
        .map((verb) => (
          <span key={verb} className="text-muted-foreground truncate text-xs">
            {verb}
          </span>
        ))}
    </>
  )
  const shape = 'flex min-w-0 flex-col gap-0.5 rounded px-2 py-1.5 text-left'
  // Not a disabled button: a host with no viewport to move is not a control
  // that failed, it is a surface that has no jump to offer. A dead button
  // invites the press that does nothing.
  return onOpen === undefined ? (
    <div className={shape}>{body}</div>
  ) : (
    <button type="button" onClick={() => onOpen(proposal.id)} className={`hover:bg-muted ${shape}`}>
      {body}
    </button>
  )
}
