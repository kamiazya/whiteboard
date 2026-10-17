/**
 * The whole path a markdown link takes into SVG — parse, layout, serialize —
 * for a scheme hidden behind a character the XML escaper deletes. The unit
 * cases are format.test.ts's; this one proves the parser really carries the
 * character as far as the serializer.
 */
import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import { describe, expect, it } from 'vitest'
import { layoutMdastBlocks } from '../layout/markdown-body.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { renderSceneToSvg } from './backend.js'

describe('renderSceneToSvg link schemes', () => {
  it('emits no javascript: href for a markdown link hiding the scheme behind an XML-invalid char', () => {
    for (const markdown of [
      '[x](java\u0085script:alert(1))',
      '[x](java\uFFFEscript:alert(1))',
      '[x](<j\x01avascript:alert(1)>)',
      '[x](java\uD800script:alert(1))',
    ]) {
      const root = parseMarkdownBody(markdown)
      // The parser keeps the invisible character, so the link really carries
      // it into layout rather than the case being vacuous.
      expect(JSON.stringify(root)).toMatch(/"url":"[^"]*(\u0085|\uFFFE|\\u0001|\\ud800)/)
      const svg = renderSceneToSvg(
        layoutMdastBlocks(root, {
          measure: createFakeMeasure(),
          maxWidth: 400,
          fontFamily: 'sans-serif',
        }),
      )
      expect(svg).toContain('<a ')
      expect(svg).not.toMatch(/href="javascript:/i)
      expect(svg).toContain('href="#"')
    }
  })
})
