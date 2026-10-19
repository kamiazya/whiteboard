// The bounds the sync judge holds a single map VALUE to — a node, an edge, a
// line, a message, a thread's anchor are each one value, so no insert run
// ever sees what they carry. Kept apart from `sync-text-limits.ts`, which
// reads an update's operations and judges these with the rest, because a
// bound here is a rule about one value and nothing about the update.
import {
  CANVAS_MAX_NODES,
  COMMENT_MESSAGE_MAX_CHARS,
  LABEL_MAX_CHARS,
  NODE_LOCATION_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
  TAG_MAX_CHARS,
  TAGS_PER_ELEMENT_MAX,
} from '@kamiazya/whiteboard-model'
import type { ContainerID, LoroDoc } from 'loro-crdt'
import { ANCHOR_FIELD } from './comment-threads.js'
import {
  CANVAS_KEY,
  CANVAS_TAGS_FIELD,
  EDGES_KEY,
  LINES_KEY,
  NODES_KEY,
  THREADS_KEY,
} from './containers.js'
import {
  anchorNodeIdCount,
  fieldLength,
  longestTag,
  nodeLocationLength,
  nodeTextLength,
  tagsIn,
} from './value-lengths.js'
import { WORKSPACE_TREE_KEY } from './workspace-tree.js'

/** A value an update set past one of `BOUNDED_VALUES`' bounds, as `SyncTextBreach` names it. */
export type ValueBreach =
  | {
      readonly shape: 'node-text'
      readonly chars: number
      readonly nodeId: string
      /** The map holding the node, so a caller can name the document. */
      readonly container: ContainerID
    }
  | {
      readonly shape: 'node-location'
      readonly chars: number
      readonly nodeId: string
      readonly container: ContainerID
    }
  | {
      readonly shape: 'label'
      readonly chars: number
      readonly elementId: string
      readonly container: ContainerID
    }
  | {
      readonly shape: 'comment-message'
      readonly chars: number
      readonly messageId: string
      readonly container: ContainerID
    }
  | {
      readonly shape: 'tags'
      /** Which bound: how many tags, or the longest one's length. */
      readonly measure: 'count' | 'chars'
      readonly amount: number
      /** The node or edge carrying them, or `null` for the board's own. */
      readonly elementId: string | null
      readonly container: ContainerID
    }
  | {
      readonly shape: 'thread-anchor'
      /** How many nodes the anchor would name. */
      readonly count: number
      readonly threadId: string
      /** The thread's own map, so a caller can name the document. */
      readonly container: ContainerID
    }

/**
 * Whether `container` is a thread's message map — under a document's root or
 * a workspace-tree node, `threads` > thread > `messages`.
 */
function isThreadMessages(doc: LoroDoc, container: ContainerID): boolean {
  const path = doc.getPathToContainer(container)
  if (path?.at(-1) !== 'messages' || path.at(-3) !== THREADS_KEY) return false
  return path.length === 3 || (path.length === 5 && path[0] === WORKSPACE_TREE_KEY)
}

/**
 * Whether `container` is one thread's own map — under a document's root or a
 * workspace-tree node, `threads` > thread.
 */
function isThread(doc: LoroDoc, container: ContainerID): boolean {
  const path = doc.getPathToContainer(container)
  if (path?.at(-2) !== THREADS_KEY) return false
  return path.length === 2 || (path.length === 4 && path[0] === WORKSPACE_TREE_KEY)
}

/**
 * Text a write bound holds that lives in a map VALUE rather than a text
 * container — a node, an edge, a line, a message is each one value — so no
 * insert run ever sees it. Each says how long a value's text is, which maps
 * hold such values, and how a breach of it is named.
 */
export interface BoundedValue {
  readonly max: number
  readonly length: (value: unknown) => number
  readonly holds: (doc: LoroDoc, container: ContainerID, key: string) => boolean
  readonly breach: (
    amount: number,
    key: string,
    container: ContainerID,
    doc: LoroDoc,
  ) => ValueBreach
}

/**
 * Both tag bounds, for one place tags sit: how many, and the longest. Where
 * the board's tags sit, the value under the key IS the list; on a node or an
 * edge it is the element, carrying its list in `tags`.
 */
function tagBounds(
  holds: BoundedValue['holds'],
  elementOf: (key: string) => string | null,
): BoundedValue[] {
  const measured = (measure: 'count' | 'chars', max: number, length: BoundedValue['length']) => ({
    max,
    length,
    holds,
    breach: (amount: number, key: string, container: ContainerID): ValueBreach => ({
      shape: 'tags',
      measure,
      amount,
      elementId: elementOf(key),
      container,
    }),
  })
  return [
    measured('count', TAGS_PER_ELEMENT_MAX, (value) => tagsIn(value).length),
    measured('chars', TAG_MAX_CHARS, longestTag),
  ]
}

export const BOUNDED_VALUES: readonly BoundedValue[] = [
  {
    max: NODE_TEXT_MAX_CHARS,
    length: nodeTextLength,
    holds: (doc, container) => isContentContainer(doc, container, NODES_KEY),
    breach: (chars, nodeId, container) => ({ shape: 'node-text', chars, nodeId, container }),
  },
  {
    max: NODE_LOCATION_MAX_CHARS,
    length: nodeLocationLength,
    holds: (doc, container) => isContentContainer(doc, container, NODES_KEY),
    breach: (chars, nodeId, container) => ({ shape: 'node-location', chars, nodeId, container }),
  },
  {
    // A group's label is a node field; an edge's and a line's their own.
    max: LABEL_MAX_CHARS,
    length: (value) => fieldLength(value, 'label'),
    holds: (doc, container) =>
      [NODES_KEY, EDGES_KEY, LINES_KEY].some((key) => isContentContainer(doc, container, key)),
    breach: (chars, elementId, container) => ({ shape: 'label', chars, elementId, container }),
  },
  {
    max: COMMENT_MESSAGE_MAX_CHARS,
    length: (value) => fieldLength(value, 'body'),
    holds: isThreadMessages,
    breach: (chars, messageId, container) => ({
      shape: 'comment-message',
      chars,
      messageId,
      container,
    }),
  },
  {
    // Not text, but a value's size all the same, and judged where its key is
    // set: every layout looks each named node up, resolved threads included,
    // and the open-thread ceiling counts open threads only.
    max: CANVAS_MAX_NODES,
    length: anchorNodeIdCount,
    holds: (doc, container, key) => key === ANCHOR_FIELD && isThread(doc, container),
    breach: (count, _key, container, doc) => ({
      shape: 'thread-anchor',
      count,
      threadId: String(doc.getPathToContainer(container)?.at(-1)),
      container,
    }),
  },
  ...tagBounds(
    (doc, container) =>
      [NODES_KEY, EDGES_KEY].some((key) => isContentContainer(doc, container, key)),
    (elementId) => elementId,
  ),
  ...tagBounds(
    (doc, container, key) =>
      key === CANVAS_TAGS_FIELD && isContentContainer(doc, container, CANVAS_KEY),
    () => null,
  ),
]

/**
 * Whether `container` is the content container `key` names: at a document's
 * root, or under a workspace-tree node.
 */
export function isContentContainer(doc: LoroDoc, container: ContainerID, key: string): boolean {
  const path = doc.getPathToContainer(container)
  if (path?.at(-1) !== key) return false
  return path.length === 1 || (path.length === 3 && path[0] === WORKSPACE_TREE_KEY)
}
