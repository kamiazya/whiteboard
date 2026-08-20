import type { Scene } from '../scene-graph.js'
import type { SvgDocumentOptions } from '../svg/backend.js'

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
  '<g><a href="https://example.com/a?b=1&amp;c=2"><text x="0" y="40" text-decoration="underline">link text</text></a></g>' +
  '<rect x="0" y="64" width="600" height="1" role="presentation"/>' +
  '<svg x="0" y="72" width="40" height="40" overflow="visible"><circle cx="20" cy="20" r="19.999"/></svg>' +
  '<g><g><g><text x="0" y="120">Col1</text></g>' +
  '<g transform="translate(100,0)"><text x="0" y="120">Col2</text></g></g></g>' +
  '<g><g transform="translate(24,0)"><g><text x="0" y="152">Item</text></g></g></g>' +
  '</svg>'

/**
 * Document-envelope options exercised by the cross-platform determinism
 * assertion for the `renderSceneToSvg(scene, options)` path.
 */
export const DETERMINISM_DOCUMENT_OPTIONS: SvgDocumentOptions = {
  padding: 10,
  background: '#eef2ff',
}

/**
 * Committed golden SVG string for the enveloped-document path. Regenerate
 * ONLY as a deliberate, separately-reviewed serializer-format change — same
 * discipline as `DETERMINISM_GOLDEN_SVG`.
 */
export const DETERMINISM_GOLDEN_DOCUMENT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="620" height="188" viewBox="-10 -10 620 188">' +
  '<rect x="-10" y="-10" width="620" height="188" fill="#eef2ff" role="presentation"/>' +
  '<g><text x="0" y="0">Title &amp; &lt;more&gt;</text></g>' +
  '<g><a href="https://example.com/a?b=1&amp;c=2"><text x="0" y="40" text-decoration="underline">link text</text></a></g>' +
  '<rect x="0" y="64" width="600" height="1" role="presentation"/>' +
  '<svg x="0" y="72" width="40" height="40" overflow="visible"><circle cx="20" cy="20" r="19.999"/></svg>' +
  '<g><g><g><text x="0" y="120">Col1</text></g>' +
  '<g transform="translate(100,0)"><text x="0" y="120">Col2</text></g></g></g>' +
  '<g><g transform="translate(24,0)"><g><text x="0" y="152">Item</text></g></g></g>' +
  '</svg>'

/**
 * A second, separate fixed scene covering the `shape` node kind and the
 * optional `appearance` field on shape/textRun/edge — kept apart from
 * `buildDeterminismGoldenScene` so the original golden never has to be
 * regenerated as this surface grows.
 */
export function buildShapeAppearanceGoldenScene(): Scene {
  return {
    nodes: [
      { kind: 'shape', bbox: { x: 0, y: 0, w: 100, h: 60 }, radius: 8 },
      { kind: 'shape', bbox: { x: 120, y: 0, w: 100, h: 60 } },
      {
        kind: 'shape',
        bbox: { x: 240, y: 0, w: 100, h: 60 },
        radius: 4,
        appearance: { fill: '#fff', stroke: '#000', strokeWidth: 2 },
      },
      {
        kind: 'paragraph',
        bbox: { x: 0, y: 80, w: 200, h: 16 },
        runs: [
          {
            kind: 'textRun',
            bbox: { x: 0, y: 80, w: 80, h: 16 },
            text: 'Styled',
            appearance: { fill: '#111', fontFamily: 'Inter', fontSize: 14 },
          },
        ],
      },
      {
        kind: 'edge',
        id: 'e1',
        path: [
          { x: 0, y: 120 },
          { x: 100, y: 120 },
        ],
        fromSide: 'right',
        toSide: 'left',
        // Spec-default destination arrowhead — deliberately exercised by the
        // golden so the arrow serialization format is pinned cross-platform.
        fromEnd: 'none',
        toEnd: 'arrow',
        appearance: { stroke: '#888', strokeWidth: 1.5 },
      },
    ],
  }
}

/**
 * Committed golden SVG string for `buildShapeAppearanceGoldenScene`.
 * Regenerate only as a deliberate, separately-reviewed serializer-format
 * change — same discipline as the two goldens above.
 */
export const SHAPE_APPEARANCE_GOLDEN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg">' +
  '<rect x="0" y="0" width="100" height="60" rx="8"/>' +
  '<rect x="120" y="0" width="100" height="60"/>' +
  '<rect x="240" y="0" width="100" height="60" rx="4" fill="#fff" stroke="#000" stroke-width="2"/>' +
  '<g fill="#111" font-family="Inter" font-size="14"><text x="0" y="80">Styled</text></g>' +
  '<polyline points="0,120 100,120" fill="none" stroke="#888" stroke-width="1.5" role="presentation"/>' +
  '<polygon points="100,120 90,124 90,116" fill="#888" role="presentation"/>' +
  '</svg>'
