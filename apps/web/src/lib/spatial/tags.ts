/**
 * Tags on a board's objects, for the editor ([ADR-0040](../../../../../docs/contributing/adr/0040-scoped-tags.md)):
 * the one place a tag list is written onto an object, what the board
 * already carries, and how one edit reaches several objects.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'

/**
 * A tag list is a SET (model's `tagsWriteSchema` refuses a duplicate), and
 * an empty one is spelled as the absence it means — so an object that was
 * tagged and untagged serializes like one never tagged, the same
 * canonical-emptiness rule a cleared facet bucket follows.
 */
export function withTagList<T extends { readonly tags?: readonly string[] }>(
  object: T,
  tags: readonly string[],
): T {
  const { tags: _previous, ...rest } = object
  const unique = [...new Set(tags)]
  // `Omit<T, 'tags'>` is not T to the compiler, though a spread of one is a
  // whole object of the same shape at runtime.
  return (unique.length === 0 ? rest : { ...rest, tags: unique }) as unknown as T
}

/** Every tag the board, its nodes and its edges carry, once each, sorted. */
export function collectCanvasTags(canvas: SpatialCanvas): string[] {
  const seen = new Set<string>(canvas.tags ?? [])
  for (const node of canvas.nodes) for (const tag of node.tags ?? []) seen.add(tag)
  for (const edge of canvas.edges) for (const tag of edge.tags ?? []) seen.add(tag)
  // Code-unit order, not locale order: the same list on every machine.
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * The CHANGE between what the panel showed (`before`) and what the person
 * left it as (`after`), applied to `current` — one object's own list. The
 * panel shows one object and writes to the whole selection, so what each
 * selected object gets is the tag added or the chip removed, never the
 * shown list copied over its own; set semantics, like `wb_facet_set`'s
 * `add`/`remove`.
 */
export function retag(
  current: readonly string[] | undefined,
  before: readonly string[],
  after: readonly string[],
): string[] {
  const removed = new Set(before.filter((tag) => !after.includes(tag)))
  const kept = (current ?? []).filter((tag) => !removed.has(tag))
  const added = after.filter((tag) => !before.includes(tag) && !kept.includes(tag))
  return [...kept, ...added]
}
