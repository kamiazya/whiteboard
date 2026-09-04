/**
 * Rewriting references when a document's ADDRESS changes — the follow half
 * of the survival table in apps/web's `reference-survival.test.ts`: a
 * reference written as the path breaks on a move, one written as the
 * display name breaks on a rename, and nothing rewrote either. These
 * helpers are that rewriting pass, shared by both keepers (the daemon's
 * rename routes and the browser's local files source) so a move follows
 * references identically in both modes.
 *
 * Two rules carry all the correctness:
 *
 * - **What gets rewritten must equal what resolves.** The rewriter walks
 *   the same scanner grammar the reader and the reference index use
 *   (ADR-0014's bar), and `planReferenceRewrite` only maps an alias that
 *   UNIQUELY resolved to the moved document under the old naming table — a
 *   `[[Name]]` the reader saw as literal bracket text stays literal.
 * - **Correctness over form.** A path reference becomes the new path —
 *   unless the new path would not resolve uniquely under the new table
 *   (today a display name elsewhere can still collide with it, since names
 *   share the alias space), in which case the reference is rewritten to the
 *   document id, which survives everything.
 *
 * Only PATH moves are followed. Display-name references are being retired
 * from resolution (path + id become the only written forms; names are shown
 * at render time instead — owner decision, 2026-09-03), so a name change
 * rewrites nothing rather than propping up a form on its way out.
 */
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { scanReferences } from './scan.js'

/**
 * `value` with every `[[target]]` / `![[target|label]]` whose target is a
 * key of `replacements` pointed at the mapped alias instead. Only the
 * target slice moves; the bang, brackets and label are kept byte-for-byte.
 */
export function rewriteReferenceTargets(
  value: string,
  replacements: ReadonlyMap<string, string>,
): string {
  if (replacements.size === 0) return value
  let out = ''
  let cursor = 0
  for (const match of scanReferences(value)) {
    const next = replacements.get(match.target)
    if (next === undefined) continue
    // The target slice starts after `[[` (and the `!` when present).
    const targetStart = match.index + (match.isEmbed ? 3 : 2)
    out += value.slice(cursor, targetStart) + next
    cursor = targetStart + match.target.length
  }
  return cursor === 0 ? value : out + value.slice(cursor)
}

export interface CanvasRewriteResult {
  readonly canvas: SpatialCanvas
  /** Whether anything moved — `false` returns the input object untouched. */
  readonly changed: boolean
  /**
   * Exactly the nodes that changed, for TARGETED writes. A caller must
   * never answer this rewrite with a whole-canvas resync: `readSpatialCanvas`
   * drops records the current schema cannot parse, and a whole-canvas write
   * then DELETES them — so a document holding one record from another
   * version would lose it to a rename. One `writeSpatialNode` per entry
   * here touches nothing else.
   */
  readonly changedNodes: readonly SpatialNode[]
}

/**
 * The spatial half of the same pass: wikilinks inside text nodes go through
 * `rewriteReferenceTargets`, and a file node whose `file` IS an affected
 * alias is repointed. Embed targets are document ids and ids survive both
 * kinds of change, so embeds are never rewritten. Untouched nodes keep
 * their identity so a caller (and Loro) can tell what actually moved.
 */
export function rewriteCanvasReferences(
  canvas: SpatialCanvas,
  replacements: ReadonlyMap<string, string>,
): CanvasRewriteResult {
  const changedNodes: SpatialNode[] = []
  const nodes = canvas.nodes.map((node): SpatialNode => {
    if (node.type === 'text') {
      const text = rewriteReferenceTargets(node.text, replacements)
      if (text === node.text) return node
      const next = { ...node, text }
      changedNodes.push(next)
      return next
    }
    if (node.type === 'file') {
      const target = replacements.get(node.file)
      if (target === undefined) return node
      const next = { ...node, file: target }
      changedNodes.push(next)
      return next
    }
    return node
  })
  return changedNodes.length > 0
    ? { canvas: { ...canvas, nodes }, changed: true, changedNodes }
    : { canvas, changed: false, changedNodes }
}

export interface DocumentMove {
  readonly movedId: string
  readonly from: string
  readonly to: string
}

/**
 * A path change is a SUBTREE move: `moveDocument({from: 'a', to: 'b'})`
 * carries every descendant with it, so following only the root would leave
 * `[[a/child]]` pointing at nothing. This derives one move per affected
 * document from the pre-move listing, and both keepers derive through it so
 * neither can forget the descendants. Prefix matching is per SEGMENT —
 * `folder-notes` is a sibling of `folder`, not a descendant.
 */
export function movesForPathChange(
  entries: readonly { readonly documentId?: string; readonly id?: string; readonly path: string }[],
  from: string,
  to: string,
): DocumentMove[] {
  const prefix = `${from}/`
  const moves: DocumentMove[] = []
  for (const entry of entries) {
    const movedId = entry.documentId ?? entry.id
    if (movedId === undefined) continue
    if (entry.path === from) moves.push({ movedId, from, to })
    else if (entry.path.startsWith(prefix)) {
      moves.push({ movedId, from: entry.path, to: to + entry.path.slice(from.length) })
    }
  }
  return moves
}

export interface ReferenceRewritePlanInput {
  /**
   * The table BEFORE the change. Only ids matter beside the moves: display
   * names are retired from resolution (the alias space is paths + ids), so
   * a path cannot be shadowed by anything except a live document id.
   */
  readonly entries: readonly {
    readonly id: string
    readonly path: string
  }[]
  readonly moves: readonly DocumentMove[]
}

/**
 * Which aliases to rewrite to what, for one path move (subtree moves pass
 * one entry per carried document — `movesForPathChange`). The one policy
 * decision lives here so both keepers apply it identically; the mechanical
 * rewriters above take the result.
 *
 * Paths are unique by the index's own constraint, so the only alias
 * question left is the reader's id-first rule: an alias spelling a LIVE
 * document id resolves to that document no matter whose path it also is —
 * such an old path is never rewritten, and such a new path falls back to
 * the moved document's id, which survives everything.
 */
export function planReferenceRewrite(
  input: ReferenceRewritePlanInput,
): ReadonlyMap<string, string> {
  const liveIds = new Set(input.entries.map((entry) => entry.id))
  const plan = new Map<string, string>()
  for (const { movedId, from, to } of input.moves) {
    if (to === from) continue
    if (liveIds.has(from)) continue
    plan.set(from, liveIds.has(to) ? movedId : to)
  }
  return plan
}
