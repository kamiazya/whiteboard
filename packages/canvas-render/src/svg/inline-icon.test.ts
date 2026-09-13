/**
 * An inline icon is painted through the SAME `<symbol>`/`<use>` machinery an
 * `IconSceneNode` already uses — one definition per icon, whatever mixture
 * of node icons and inline ones a document holds.
 *
 * That matters beyond tidiness: the set's paint lives ON the definition and
 * only the stroke COLOR inherits through each `<use>`, so a second producer
 * emitting its own definition would be a second place for a contributed
 * icon's viewBox and paint convention to be got wrong.
 */
import type { Scene } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { renderSceneToSvg } from './backend.js'

const box = { x: 0, y: 0, w: 16, h: 16 }

const runScene = (paints: { kind: 'icon'; name: string }, text = ' '): Scene => ({
  nodes: [
    {
      kind: 'paragraph',
      bbox: { x: 0, y: 0, w: 100, h: 16 },
      runs: [{ kind: 'textRun', bbox: box, text, paints }],
    },
  ],
})

describe('a run that paints an icon', () => {
  it('references the icon symbol rather than drawing its own text', () => {
    const svg = renderSceneToSvg(runScene({ kind: 'icon', name: 'star' }))
    expect(svg).toContain('<use')
    expect(svg).toContain('href="#wb-icon-star"')
    expect(svg).toContain('viewBox="0 0 24 24"')
    expect(svg).not.toContain('<text')
  })

  /**
   * A body run names no fill of its own precisely so it inherits the host's
   * (see `Appearance.fillOpacity`). An icon is STROKED, and no host sets a
   * stroke, so it has to ask for the same colour the prose resolved to or it
   * would take the SVG default — black — on every theme.
   */
  it('strokes with the colour the surrounding prose resolved to', () => {
    expect(renderSceneToSvg(runScene({ kind: 'icon', name: 'star' }))).toContain(
      'stroke="currentColor"',
    )
  })

  it('takes the run’s own fill when it has one, so an icon in a link matches it', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'paragraph',
          bbox: { x: 0, y: 0, w: 100, h: 16 },
          runs: [
            {
              kind: 'textRun',
              bbox: box,
              text: ' ',
              paints: { kind: 'icon', name: 'star' },
              appearance: { fill: '#3b82f6' },
            },
          ],
        },
      ],
    }
    expect(renderSceneToSvg(scene)).toContain('stroke="#3b82f6"')
  })

  /**
   * The name is not resolvable everywhere: a deployment supplies its own
   * icon table, and a document naming an icon that table lacks must still
   * say something. The run's text is what it says.
   */
  it('falls back to painting the run’s text when the table has no such icon', () => {
    const svg = renderSceneToSvg(runScene({ kind: 'icon', name: 'no-such-icon' }, ':icon-nope:'))
    expect(svg).toContain('<text')
    expect(svg).toContain(':icon-nope:')
    expect(svg).not.toContain('<use')
  })

  it('defines the symbol once when a node icon and an inline one share a name', () => {
    const scene: Scene = {
      nodes: [
        { kind: 'icon', bbox: box, icon: 'star' },
        {
          kind: 'paragraph',
          bbox: { x: 0, y: 20, w: 100, h: 16 },
          runs: [
            {
              kind: 'textRun',
              bbox: { ...box, y: 20 },
              text: ' ',
              paints: { kind: 'icon', name: 'star' },
            },
          ],
        },
      ],
    }
    const svg = renderSceneToSvg(scene)
    expect(svg.match(/<symbol id="wb-icon-star"/g)).toHaveLength(1)
    expect(svg.match(/<use /g)).toHaveLength(2)
  })
})
