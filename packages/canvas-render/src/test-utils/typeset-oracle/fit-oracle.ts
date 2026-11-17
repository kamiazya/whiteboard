import type { SceneNode } from '@kamiazya/whiteboard-scene'

/**
 * The shape of a frozen recording (ADR-0054 step 7, S18h): what the TypeScript answered before it was deleted. The Rust port replays the recording natively; nothing here answers it again.
 */
/**
 * Inputs and answers of `fitBlocksToHeight` and `firstLineOfBlocks`, the cuts a
 * node's laid-out blocks are trimmed to. A record holds the laid-out nodes as data
 * (so the replay needs no layout), and for each height what was kept: the nodes
 * as a digest of their canonical text and the two signals, and for the scenes written
 * by hand the text itself.
 */
interface FitAnswer {
  /** The height's IEEE bits. */
  readonly height: string
  readonly n: number
  readonly h: number
  readonly truncated: boolean
  readonly overflows: boolean
  /** The kept nodes' canonical text, held only for the small scenes. */
  readonly text?: string
}

export interface FitRecord {
  readonly id: string
  readonly nodes: readonly SceneNode[]
  readonly fits: readonly FitAnswer[]
  readonly first: Omit<FitAnswer, 'height'>
}
