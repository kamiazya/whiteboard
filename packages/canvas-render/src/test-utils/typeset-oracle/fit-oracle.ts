import type { Scene, SceneNode } from '@kamiazya/whiteboard-scene'
import { firstLineOfBlocks, fitBlocksToHeight } from '../../layout/nodes/mdast-blocks.js'
import { typesetInputs } from './corpus.js'
import { HAND_SCENES } from './fit-scenes.js'
import { canonicalDump, digestOf, f64Hex, fromHex, layoutOf } from './oracle.js'

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

const FIXED_HEIGHTS = [
  -1,
  Number.NaN,
  0,
  12,
  30,
  50,
  80,
  130,
  200,
  320,
  600,
  1e9,
  Number.POSITIVE_INFINITY,
]

/** Every height that puts the edge of a block exactly at, and a hair either side of, the cut. */
function heightsFor(nodes: readonly SceneNode[]): number[] {
  const edges: number[] = []
  for (const node of nodes.slice(0, 4)) {
    if (node.kind === 'edge') continue
    const bottom = node.bbox.y + node.bbox.h
    edges.push(bottom, bottom - 0.001, bottom + 0.001)
  }
  return [...FIXED_HEIGHTS, ...edges]
}

const answerOf = (
  kept: { nodes: readonly SceneNode[]; truncated: boolean; overflows: boolean },
  withText: boolean,
) => {
  const text = canonicalDump({ nodes: [...kept.nodes] })
  return {
    ...digestOf(text),
    truncated: kept.truncated,
    overflows: kept.overflows,
    ...(withText ? { text } : {}),
  }
}

function fitAnswer(id: string, nodes: readonly SceneNode[]): FitRecord {
  const small = id.startsWith('hand-scene/')
  return {
    id,
    nodes,
    fits: heightsFor(nodes).map((height) => ({
      height: f64Hex(height),
      ...answerOf(fitBlocksToHeight(nodes, height), small),
    })),
    first: answerOf(firstLineOfBlocks(nodes), small),
  }
}

/** The recorded inputs are re-answered from the nodes and heights alone. */
export function reanswer(record: FitRecord): FitRecord {
  const small = record.id.startsWith('hand-scene/')
  return {
    ...record,
    fits: record.fits.map((fit) => ({
      height: fit.height,
      ...answerOf(fitBlocksToHeight(record.nodes, fromHex(fit.height)), small),
    })),
    first: answerOf(firstLineOfBlocks(record.nodes), small),
  }
}

const viaJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** Laid-out scenes of the hand corpora at one finite width each, and the scenes written by hand. */
export function fitRecords(): readonly FitRecord[] {
  const wanted = /^(hand|blocks|containers|wrap|embeds)\/.*@(160|96)(\/full)?$/
  const laid = typesetInputs(false)
    .filter((input) => wanted.test(input.id))
    .map((input): [string, Scene] => [`laid/${input.id}`, layoutOf(input).scene])
  const scenes: [string, Scene][] = [...laid, ...HAND_SCENES]
  return scenes
    .map(([id, scene]) => fitAnswer(id, viaJson(scene.nodes)))
    .filter((record) => JSON.stringify(record.nodes).length < 9000)
}
