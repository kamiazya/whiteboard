import type { SceneNode } from '@kamiazya/whiteboard-scene'
import { fitSceneIntoBox } from '../../layout/scale-scene.js'
import { buildEveryKindScene } from '../render-oracle/every-kind-scene.js'

/**
 * `fitSceneIntoBox` over a scene of every kind, a nested canvas's answer, and an
 * empty scene, in boxes that leave each scene its own size, shrink it by width
 * or by height, or leave no room (empty, negative and non-finite) — the fits a
 * file node's canvas and a body's canvas embed are drawn by.
 */

export interface FitRecord {
  readonly kind: 'fit'
  readonly id: string
  readonly scene: readonly SceneNode[]
  /** `[x, y, maxWidth, maxHeight]` as IEEE bits. */
  readonly box: readonly string[]
  readonly answer: { readonly scene: string; readonly w: string; readonly h: string } | null
}

/** A code block whose whole value is one `<text>` carries no runs. */
const BARE_CODE: SceneNode = {
  kind: 'codeBlock',
  bbox: { x: 0, y: 610, w: 80, h: 20 },
  value: 'x',
}

const BOXES: readonly (readonly [number, number, number, number])[] = [
  [3, 4, 10_000, 10_000],
  [10.5, -20, 300, 900],
  [0, 0, 1000, 100.25],
  [-7, 9, 0, 50],
  [0, 0, 40, -1],
  [0, 0, Number.NaN, 40],
  [0, 0, 40, Number.POSITIVE_INFINITY],
]

/** Every record, from the recording's own helpers: how a double is written and a scene dumped. */
export function fitRecords(
  hex: (value: number) => string,
  dump: (nodes: readonly SceneNode[]) => string,
  miniature: readonly SceneNode[],
): readonly FitRecord[] {
  const scenes: Readonly<Record<string, readonly SceneNode[]>> = {
    every: [...buildEveryKindScene().nodes, BARE_CODE],
    miniature,
    empty: [],
  }
  return Object.entries(scenes).flatMap(([name, scene]) =>
    BOXES.map(([x, y, maxWidth, maxHeight], at) => {
      const fitted = fitSceneIntoBox({ nodes: [...scene] }, { x, y, maxWidth, maxHeight })
      const wire = JSON.parse(JSON.stringify(scene)) as readonly SceneNode[]
      if (dump(wire) !== dump(scene)) {
        throw new Error(`compose-node-oracle: the ${name} scene does not survive JSON`)
      }
      return {
        kind: 'fit' as const,
        id: `fit/${name}/${at}`,
        scene: wire,
        box: [x, y, maxWidth, maxHeight].map(hex),
        answer:
          fitted === undefined
            ? null
            : { scene: dump(fitted.nodes), w: hex(fitted.w), h: hex(fitted.h) },
      }
    }),
  )
}
