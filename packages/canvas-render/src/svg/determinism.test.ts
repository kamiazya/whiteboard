import { describe, expect, it } from 'vitest'
import {
  buildDeterminismGoldenScene,
  buildShapeAppearanceGoldenScene,
  DETERMINISM_DOCUMENT_OPTIONS,
  DETERMINISM_GOLDEN_DOCUMENT_SVG,
  DETERMINISM_GOLDEN_SVG,
  SHAPE_APPEARANCE_GOLDEN_SVG,
} from '../test-utils/golden-scene.js'
import { renderSceneToSvg } from './backend.js'

describe('renderSceneToSvg — cross-platform determinism (node)', () => {
  it('matches the committed golden SVG string byte-for-byte', () => {
    const svg = renderSceneToSvg(buildDeterminismGoldenScene())
    expect(svg).toBe(DETERMINISM_GOLDEN_SVG)
  })

  it('matches the committed document-envelope golden SVG string byte-for-byte', () => {
    const svg = renderSceneToSvg(buildDeterminismGoldenScene(), DETERMINISM_DOCUMENT_OPTIONS)
    expect(svg).toBe(DETERMINISM_GOLDEN_DOCUMENT_SVG)
  })

  it('matches the committed shape/appearance golden SVG string byte-for-byte', () => {
    const svg = renderSceneToSvg(buildShapeAppearanceGoldenScene())
    expect(svg).toBe(SHAPE_APPEARANCE_GOLDEN_SVG)
  })
})
