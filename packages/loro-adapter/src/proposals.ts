import {
  type Proposal,
  type ProposedChange,
  type ProposedChangeStatus,
  proposalSchema,
  proposedChangeSchema,
} from '@kamiazya/whiteboard-model'
import { LoroMap } from 'loro-crdt'
import { type DocumentContainers, PROPOSALS_KEY } from './containers.js'
import { openMergeableMap } from './mergeable-containers.js'

/** The nested map of changes inside one proposal's container. */
const CHANGES_KEY = 'changes'
const AUTHOR_FIELD = 'author'
const CREATED_AT_FIELD = 'createdAt'
const STATUS_FIELD = 'status'

function proposalContainer(doc: DocumentContainers, proposalId: string): LoroMap | undefined {
  const stored = doc.getMap(PROPOSALS_KEY).get(proposalId)
  return stored instanceof LoroMap ? stored : undefined
}

function changesOf(container: LoroMap): LoroMap | undefined {
  const stored = container.get(CHANGES_KEY)
  return stored instanceof LoroMap ? stored : undefined
}

/**
 * Creates or replaces one proposal's own fields and writes its changes.
 *
 * `openMergeableMap` and not `setContainer`: the latter REPLACES the
 * container, discarding whatever a peer put in it. A proposal's key is not
 * minted by this writer — two keepers can reach here with the same id having
 * never seen each other's write, the same way they can for a thread.
 *
 * Inside, a change is a PLAIN VALUE under its own id rather than a container
 * of its own — the one place this differs from `comment-threads.ts`, and the
 * difference is derived rather than stylistic. A thread needs the extra level
 * because two peers write DIFFERENT messages into one thread concurrently,
 * and stored as one value the second would erase the first. A change has no
 * such pair: the only write after its creation is a verdict, and two verdicts
 * on two changes are already two keys. Two verdicts on the SAME change is a
 * genuine race whose outcome is arbitrary under any shape.
 *
 * What would change that answer is a change whose PAYLOAD becomes editable —
 * a person adjusting a proposed geometry before adopting it. That is when the
 * status earns a key of its own.
 */
export function writeProposal(doc: DocumentContainers, proposal: Proposal): void {
  const container = openMergeableMap(doc.getMap(PROPOSALS_KEY), proposal.id)
  if (proposal.author !== undefined) container.set(AUTHOR_FIELD, proposal.author)
  if (proposal.createdAt !== undefined) container.set(CREATED_AT_FIELD, proposal.createdAt)
  const changes = openMergeableMap(container, CHANGES_KEY)
  for (const change of proposal.changes) changes.set(change.id, { ...change })
  doc.commit()
}

/**
 * Adopts or dismisses ONE change, leaving every other change in the batch
 * open. Whole-proposal adoption (ADR-0029 decision 4's default) is this
 * applied to each open change — the default is a shortcut through the same
 * write, not a second one, so the two can never disagree.
 *
 * A no-op for a proposal or change this replica does not hold: a verdict must
 * never be the write that opens a container, or a lost import becomes a
 * half-formed decision nobody made.
 */
export function setProposedChangeStatus(
  doc: DocumentContainers,
  proposalId: string,
  changeId: string,
  status: ProposedChangeStatus,
): void {
  setProposedChangeStatusInto(doc, proposalId, changeId, status)
  doc.commit()
}

/** The stamp itself, without the commit — see `withDocumentBatch`. */
export function setProposedChangeStatusInto(
  doc: DocumentContainers,
  proposalId: string,
  changeId: string,
  status: ProposedChangeStatus,
): void {
  const container = proposalContainer(doc, proposalId)
  if (container === undefined) return
  const changes = changesOf(container)
  if (changes === undefined) return
  const stored = changes.get(changeId)
  if (stored === undefined || stored === null || typeof stored !== 'object') return
  changes.set(changeId, { ...(stored as Record<string, unknown>), [STATUS_FIELD]: status })
}

/**
 * Every proposal the document holds, ordered by id and with each proposal's
 * changes in id order, so two replicas that merged the same writes render the
 * same list.
 *
 * A record the schema rejects costs that record and nothing beside it — the
 * contract every reader in this package keeps.
 */
export function readProposals(doc: DocumentContainers): Proposal[] {
  const proposalsMap = doc.getMap(PROPOSALS_KEY)
  const proposals: Proposal[] = []
  for (const proposalId of proposalsMap.keys()) {
    const container = proposalContainer(doc, proposalId)
    if (container === undefined) continue
    const changesContainer = changesOf(container)
    const changes: ProposedChange[] = []
    if (changesContainer !== undefined) {
      for (const changeId of changesContainer.keys()) {
        const parsed = proposedChangeSchema.safeParse(changesContainer.get(changeId))
        if (parsed.success) changes.push(parsed.data)
      }
    }
    const author = container.get(AUTHOR_FIELD)
    const createdAt = container.get(CREATED_AT_FIELD)
    const parsed = proposalSchema.safeParse({
      id: proposalId,
      ...(author === undefined ? {} : { author }),
      ...(createdAt === undefined ? {} : { createdAt }),
      changes: changes.sort(byId),
    })
    if (parsed.success) proposals.push(parsed.data)
  }
  return proposals.sort(byId)
}

function byId(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
