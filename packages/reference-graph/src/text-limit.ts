import {
  MARKDOWN_LIMIT_PHRASE,
  NODE_TEXT_LIMIT_PHRASE,
  refusalMessage,
} from '@kamiazya/whiteboard-model'

/**
 * The two bounds a reference rewrite can break: a markdown body's and a text
 * node's. The `shape` names are the sync write's own (`SYNC_TEXT_BREACH_CODES`
 * keys), so a keeper answers a refused rewrite with the code a refused sync
 * write has. No container is named: a rewrite is planned from plain content,
 * which has none, and the keeper knows which document it asked about.
 */
export type ReferenceRewriteBreach =
  | { readonly shape: 'body'; readonly chars: number }
  | { readonly shape: 'node-text'; readonly chars: number; readonly nodeId: string }

/**
 * A reference rewrite — Link-mentions, or following a move — refused because
 * the text it would leave is past the ceiling every other write to it is held
 * to. Nothing was planned, so nothing is written.
 */
export class ReferenceRewriteTooLargeError extends Error {
  constructor(readonly breach: ReferenceRewriteBreach) {
    super(
      breach.shape === 'body'
        ? refusalMessage('ReferenceRewriteBodyTooLarge', {
            chars: breach.chars,
            limit: MARKDOWN_LIMIT_PHRASE,
          })
        : refusalMessage('ReferenceRewriteNodeTextTooLarge', {
            nodeId: breach.nodeId,
            chars: breach.chars,
            limit: NODE_TEXT_LIMIT_PHRASE,
          }),
    )
    this.name = 'ReferenceRewriteTooLargeError'
  }
}
