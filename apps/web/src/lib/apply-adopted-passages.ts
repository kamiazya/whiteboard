import type { DocumentContainers } from '@kamiazya/whiteboard-loro-adapter'
import { readMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import type {
  BodyProposedChange,
  ProposedChange,
  ResolvedPassage,
} from '@kamiazya/whiteboard-model'
import { applyBodyChange, resolveTextAnchor } from '@kamiazya/whiteboard-model'

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
 * Applied from the last passage backwards so an earlier rewrite never shifts
 * the offsets a later one was resolved at — every position comes from ONE
 * read of the body, exactly as `wb_body_edit` does it on the other side.
 */
export function applyAdoptedPassages(
  doc: DocumentContainers,
  changes: readonly ProposedChange[],
  write: (body: string) => void,
): void {
  const passages = changes.filter((change) => change.op === 'body.replace')
  if (passages.length === 0) return
  const body = readMarkdownBody(doc)
  const placed: { readonly change: BodyProposedChange; readonly at: ResolvedPassage }[] = []
  for (const change of passages) {
    const resolved = resolveTextAnchor(body, change.anchor)
    if (resolved.kind !== 'placed') continue
    placed.push({ change, at: { start: resolved.start, end: resolved.end } })
  }
  if (placed.length === 0) return
  const next = [...placed]
    .sort((a, b) => b.at.start - a.at.start)
    .reduce((text, { change, at }) => applyBodyChange(text, change, at), body)
  if (next !== body) write(next)
}
