// The bundled plugin's themes reach a canvas through the DEFAULT contribution
// set — no composition-root wiring — the same way its silhouettes do: a
// document that names `visual.sketch` or `visual.neon` draws that way
// wherever a caller asks for the document's style.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { ResolvedEdgeNode, Scene, ShapeSceneNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { renderSceneToSvg } from '../svg/backend.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { layoutSpatialCanvas, type SpatialLayoutOptions } from './spatial-canvas.js'

const THEME_KEY = 'visual.theme/v0'

const canvasIn = (theme: string | undefined): SpatialCanvas => ({
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 120, height: 60, text: 'a', color: '5' },
    { id: 'b', type: 'text', x: 300, y: 200, width: 120, height: 60, text: 'b' },
  ],
  edges: [
    {
      id: 'e',
      from: { node: 'a' },
      to: { node: 'b' },
    },
  ],
  ...(theme === undefined ? {} : { facets: { [THEME_KEY]: { theme } } }),
})

function options(over?: Partial<SpatialLayoutOptions>): SpatialLayoutOptions {
  return {
    measure: createFakeMeasure(),
    parseBody: () => ({ type: 'root', children: [] }),
    appearance: createSpatialTheme({ mode: 'dark' }),
    ...over,
  }
}

const shape = (scene: Scene, id: string) =>
  scene.nodes.find((n): n is ShapeSceneNode => n.kind === 'shape' && n.id === id)
const edge = (scene: Scene) => scene.nodes.find((n): n is ResolvedEdgeNode => n.kind === 'edge')

describe('the bundled themes, through the default contributions', () => {
  it('visual.sketch inks every node and edge and routes straight, like the bundled look', () => {
    const scene = layoutSpatialCanvas(canvasIn('visual.sketch'), options({ style: 'document' }))
    expect(shape(scene, 'a')?.ink).toMatchObject({ style: 'sketch', fill: 'hatch' })
    expect(shape(scene, 'b')?.ink).toMatchObject({ style: 'sketch' })
    expect(edge(scene)?.ink).toMatchObject({ style: 'sketch' })
    // The pencil changes how a line is drawn, not where it goes: a straight
    // edge under the theme follows the same path as under the bundled look.
    const plain = layoutSpatialCanvas(canvasIn(undefined), options())
    expect(edge(scene)?.path).toEqual(edge(plain)?.path)
    expect(renderSceneToSvg(scene)).toContain('stroke-linecap="round"')
  })

  it('visual.neon glows in the dark palette and routes orthogonally', () => {
    const scene = layoutSpatialCanvas(canvasIn('visual.neon'), options({ style: 'document' }))
    expect(shape(scene, 'a')?.appearance?.glow).toEqual({ radiusPx: 6 })
    expect(shape(scene, 'a')?.appearance?.stroke).toBe('#67e8f9')
    expect(shape(scene, 'a')?.ink).toBeUndefined()
    expect(edge(scene)?.rounded).toBeUndefined()
    expect(renderSceneToSvg(scene)).toContain('filterUnits="userSpaceOnUse"')
  })

  it('the same document under the library default draws the bundled look', () => {
    const themed = layoutSpatialCanvas(canvasIn('visual.neon'), options())
    const plain = layoutSpatialCanvas(canvasIn(undefined), options())
    expect(themed).toEqual(plain)
  })

  it('a document naming a theme this build lacks draws the bundled look and says so', () => {
    const events: unknown[] = []
    const scene = layoutSpatialCanvas(
      canvasIn('infra.aws'),
      options({ style: 'document', onDegrade: (e) => events.push(e) }),
    )
    expect(shape(scene, 'a')?.appearance?.glow).toBeUndefined()
    expect(events).toEqual([{ kind: 'unknown-theme', theme: 'infra.aws' }])
  })
})
