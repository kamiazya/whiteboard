import type { Scene } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { renderSceneToSvg } from './backend.js'

const scene: Scene = {
  nodes: [{ kind: 'thematicBreak', bbox: { x: 100, y: 200, w: 100, h: 10 } }],
  legend: {
    keys: [
      {
        key: 'health',
        of: 'boxes',
        entries: [
          { value: 'failing', count: 1, swatch: { fill: '#fee', stroke: '#c00' } },
          { value: 'ok', count: 2, swatch: { fill: '#efe', stroke: '#080' } },
        ],
      },
      {
        key: 'link',
        of: 'edges',
        entries: [{ value: 'slow', count: 1, swatch: { stroke: '#c60' } }],
      },
    ],
    uncarried: { boxes: false, edges: true },
  },
}

describe('the legend panel', () => {
  // Key headings, value rows and the muted "no key carries it" line are each
  // placed by their own row arithmetic, so each one can stack onto the same y
  // without the others noticing.
  it('gives every line its own row, one row apart, inside the panel', () => {
    const svg = renderSceneToSvg(scene, { viewBox: { x: 100, y: 200, w: 400, h: 300 }, padding: 0 })
    const legend = svg.slice(svg.indexOf('data-wb-legend'))
    const panelHeight = Number(
      /<rect x="0" y="0" width="[\d.]+" height="([\d.]+)"/.exec(legend)?.[1],
    )
    const lines = [...legend.matchAll(/<text x="[\d.]+" y="([\d.]+)"[^>]*font-size="([\d.]+)"/g)]
    const ys = lines.map((m) => Number(m[1]))
    const fontSize = Number(lines[0]?.[2])
    // health, failing, ok, link, slow, and the muted edge-colour line.
    expect(ys).toHaveLength(6)
    const gaps = ys.slice(1).map((y, i) => y - (ys[i] as number))
    expect(gaps[0]).toBeGreaterThanOrEqual(fontSize)
    for (const gap of gaps) expect(gap).toBe(gaps[0])
    expect(Math.max(...ys)).toBeLessThanOrEqual(panelHeight)
  })

  it('a legend listing no key is neither drawn nor given a band', () => {
    const uncarriedOnly: Scene = {
      nodes: scene.nodes,
      legend: { keys: [], uncarried: { boxes: true, edges: true } },
    }
    const svg = renderSceneToSvg(uncarriedOnly, { padding: 0 })
    expect(svg).not.toContain('data-wb-legend')
    expect(svg).not.toContain('no key carries it')
    expect(svg).toContain('viewBox="100 200 100 10"')
  })
})
