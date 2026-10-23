import type { Scene } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { SPATIAL_THEME_FONT_FAMILY } from '../theme/font-family.js'
import { renderSceneToSvg } from './backend.js'

describe('renderSceneToSvg — font family', () => {
  it('gives the vendored family a generic fallback chain, Roboto first', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'paragraph',
          bbox: { x: 0, y: 0, w: 100, h: 16 },
          runs: [
            {
              kind: 'textRun',
              bbox: { x: 0, y: 0, w: 40, h: 16 },
              text: 'themed',
              appearance: { fontFamily: SPATIAL_THEME_FONT_FAMILY },
            },
          ],
        },
      ],
    }
    expect(renderSceneToSvg(scene)).toContain('font-family="Roboto, system-ui, sans-serif"')
  })
})
