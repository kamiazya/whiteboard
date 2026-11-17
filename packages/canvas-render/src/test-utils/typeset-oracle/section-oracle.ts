import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'

/**
 * The shape of a frozen recording (ADR-0054 step 7, S18h): what the TypeScript answered before it was deleted. The Rust port replays the recording natively; nothing here answers it again.
 */
/**
 * Inputs and answers of `selectMarkdownSection`, the part of a document a
 * `#fragment` names. An answer is the half-open range of the root's blocks it
 * keeps, or null, so the replay compares which blocks and not a copy of them.
 */
export interface SectionRecord {
  readonly id: string
  readonly root: MdastRoot
  readonly fragment: string
  readonly range: readonly [number, number] | null
}
