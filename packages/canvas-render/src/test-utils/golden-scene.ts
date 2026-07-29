import type { Scene } from '../scene-graph.js'

/**
 * A fixed scene used by the cross-platform determinism assertion: the same
 * scene must serialize to byte-identical SVG on Node and in a real browser.
 * Kept intentionally small and content-diverse (text run, link, decorative
 * rect, verbatim math fragment) to exercise every formatting rule at once.
 */
export function buildDeterminismGoldenScene(): Scene {
  return {
    nodes: [
      {
        kind: 'heading',
        bbox: { x: 0, y: 0, w: 600, h: 32 },
        level: 1,
        runs: [{ kind: 'textRun', bbox: { x: 0, y: 0, w: 120, h: 32 }, text: 'Title & <more>' }],
      },
      {
        kind: 'paragraph',
        bbox: { x: 0, y: 40, w: 600, h: 16 },
        runs: [
          {
            kind: 'textRun',
            bbox: { x: 0, y: 40, w: 80, h: 16 },
            text: 'link text',
            link: { kind: 'link', href: 'https://example.com/a?b=1&c=2' },
          },
        ],
      },
      { kind: 'thematicBreak', bbox: { x: 0, y: 64, w: 600, h: 1 } },
      {
        kind: 'svgFragment',
        bbox: { x: 0, y: 72, w: 40, h: 40 },
        svg: '<circle cx="20" cy="20" r="19.999"/>',
      },
      {
        kind: 'table',
        bbox: { x: 0, y: 120, w: 200, h: 24 },
        rows: [
          {
            kind: 'tableRow',
            bbox: { x: 0, y: 120, w: 200, h: 24 },
            cells: [
              {
                kind: 'tableCell',
                bbox: { x: 0, y: 120, w: 100, h: 24 },
                runs: [{ kind: 'textRun', bbox: { x: 0, y: 120, w: 30, h: 16 }, text: 'Col1' }],
              },
              {
                kind: 'tableCell',
                bbox: { x: 100, y: 120, w: 100, h: 24 },
                runs: [{ kind: 'textRun', bbox: { x: 0, y: 120, w: 30, h: 16 }, text: 'Col2' }],
              },
            ],
          },
        ],
      },
      {
        kind: 'list',
        bbox: { x: 0, y: 152, w: 200, h: 16 },
        ordered: false,
        depth: 0,
        items: [
          {
            kind: 'listItem',
            bbox: { x: 24, y: 152, w: 176, h: 16 },
            children: [
              {
                kind: 'paragraph',
                bbox: { x: 0, y: 152, w: 176, h: 16 },
                runs: [{ kind: 'textRun', bbox: { x: 0, y: 152, w: 40, h: 16 }, text: 'Item' }],
              },
            ],
          },
        ],
      },
    ],
  }
}

/**
 * Committed golden SVG string. Regenerate ONLY when a deliberate change to
 * the serializer's canonical rules is made — a diff here should be reviewed
 * as a wire-format change, not accepted blindly.
 */
export const DETERMINISM_GOLDEN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg">' +
  '<g><text x="0" y="0">Title &amp; &lt;more&gt;</text></g>' +
  '<g><a href="https://example.com/a?b=1&amp;c=2"><text x="0" y="40">link text</text></a></g>' +
  '<rect x="0" y="64" width="600" height="1" role="presentation"/>' +
  '<g><circle cx="20" cy="20" r="19.999"/></g>' +
  '<g><g><g><text x="0" y="120">Col1</text></g>' +
  '<g transform="translate(100,0)"><text x="0" y="120">Col2</text></g></g></g>' +
  '<g><g transform="translate(24,0)"><g><text x="0" y="152">Item</text></g></g></g>' +
  '</svg>'
