import type { SyncTextBreach } from '@kamiazya/whiteboard-loro-adapter'
import { MARKDOWN_LIMIT_PHRASE, NODE_TEXT_LIMIT_PHRASE } from '@kamiazya/whiteboard-model'

/**
 * The two bounds a reference rewrite can break: a markdown body's (never a
 * `run` — a rewrite is no one insert) and a text node's.
 */
export type ReferenceRewriteBreach =
  | (Extract<SyncTextBreach, { shape: 'run' | 'body' }> & { readonly shape: 'body' })
  | Extract<SyncTextBreach, { shape: 'node-text' }>

/**
 * A reference rewrite — Link-mentions, or following a move — refused because
 * the text it would leave is past the ceiling every other write to it is held
 * to. Nothing was written. `breach` is the same shape a sync write's refusal
 * carries, so a keeper answers it with the refusal it already has.
 */
export class ReferenceRewriteTooLargeError extends Error {
  constructor(readonly breach: ReferenceRewriteBreach) {
    super(
      breach.shape === 'body'
        ? `The links would make the document body ${breach.chars} characters long, past ${MARKDOWN_LIMIT_PHRASE}`
        : `The links would give node ${JSON.stringify(breach.nodeId)} ${breach.chars} characters of text, past ${NODE_TEXT_LIMIT_PHRASE}`,
    )
    this.name = 'ReferenceRewriteTooLargeError'
  }
}
