import type { DocumentContainers } from '@kamiazya/whiteboard-loro-adapter'
import { readMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import type { PlacedPassage, ProposedChange } from '@kamiazya/whiteboard-model'
import { applyPassages, resolveTextAnchor } from '@kamiazya/whiteboard-model'

/**
 * Rewrites the body for every `body.replace` change in an adopted decision.
 *
 * Where each passage sits is resolved HERE rather than carried on the
 * command, through the same `resolveTextAnchor` the in-place projection draws
 * with — so what the person saw highlighted and what adoption rewrites are
 * one answer, not two that could disagree. The changes themselves still
 * travel with the command; only their position is re-read, because the body
 * may have moved under them between the card being drawn and the click.
 *
 * A passage that no longer resolves is SKIPPED, not refused: its change is
 * already being stamped decided by the caller, and leaving it open would ask
 * the person the same question every time they opened the note. Nothing is
 * written for it, which is the only honest thing to do with a passage that is
 * not there.
 *
 * The body is READ from `doc` and WRITTEN through `write`, so the caller
 * decides the commit boundary — today `withDocumentBatch`, which folds this
 * rewrite into the same commit as the statuses it closes.
 *
 * Every position comes from ONE read of the body and the batch is applied by
 * `applyPassages`, the same reading `wb_body_edit` adopts with on the other
 * side.
 *
 * Two passages that have come to OVERLAP — proposed apart, then an edit
 * closed the gap between them — are skipped for the reason a vanished one is:
 * applying both writes text neither change proposed, and picking one over the
 * other is a choice nobody made. Their changes are stamped decided all the
 * same, and the disjoint rest still applies.
 */
export function applyAdoptedPassages(
  doc: DocumentContainers,
  changes: readonly ProposedChange[],
  write: (body: string) => void,
): void {
  const passages = changes.filter((change) => change.op === 'body.replace')
  if (passages.length === 0) return
  const body = readMarkdownBody(doc)
  let placed: PlacedPassage[] = []
  for (const change of passages) {
    const resolved = resolveTextAnchor(body, change.anchor)
    if (resolved.kind !== 'placed') continue
    placed.push({ change, at: { start: resolved.start, end: resolved.end } })
  }
  // Each round drops one overlapping pair, so this ends within half as many
  // rounds as there are passages.
  for (;;) {
    if (placed.length === 0) return
    const outcome = applyPassages(body, placed)
    if (outcome.kind === 'applied') {
      if (outcome.body !== body) write(outcome.body)
      return
    }
    placed = placed.filter((entry) => entry !== outcome.passage && entry !== outcome.overlaps)
  }
}
