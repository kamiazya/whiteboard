import { describe, expect, it } from 'vitest'
import { buildDeterminismGoldenScene, DETERMINISM_GOLDEN_SVG } from '../test-utils/golden-scene.js'
import { renderSceneToSvg } from './backend.js'

describe('renderSceneToSvg — cross-platform determinism (node)', () => {
  it('matches the committed golden SVG string byte-for-byte', () => {
    const svg = renderSceneToSvg(buildDeterminismGoldenScene())
    expect(svg).toBe(DETERMINISM_GOLDEN_SVG)
  })
})
