import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import type { NodeResource } from '@kamiazya/whiteboard-model'
import type { Scene, SceneNode } from '@kamiazya/whiteboard-scene'
import { typesetMdastBlocks } from '../../layout/nodes/mdast-blocks.js'
import { MARKDOWN_THEME_NODE } from '../../theme/markdown-theme.js'
import { createFakeMeasure } from '../fake-measure.js'
import { buildEveryKindScene } from '../render-oracle/every-kind-scene.js'

/**
 * The inputs of the node-box recording: what a node shows, the boxes it is
 * drawn in, the silhouettes and options a composer hands the box primitives,
 * and the content a node's box places. Every choice that is not a product is a
 * pure function of the case's index, so the corpus is the same on every run.
 */

/** What a node shows, by name; `null` is a frame. */
export const RESOURCES: Readonly<Record<string, NodeResource | null>> = {
  text: { mimeType: 'text/markdown', content: 'Hello' },
  'link-mime-content': { mimeType: 'text/uri-list', content: 'carried text wins' },
  file: { mimeType: 'application/octet-stream', location: 'notes/a.md' },
  'file-subpath': { mimeType: 'text/markdown', location: 'notes/a.md', subpath: '#Part two' },
  'file-empty-subpath': { mimeType: 'application/octet-stream', location: 'b', subpath: '' },
  image: { mimeType: 'image/png', location: 'asset:0b1c' },
  'image-subpath': { mimeType: 'image/png', location: 'asset:9f', subpath: '#crop' },
  'asset-like': { mimeType: 'application/octet-stream', location: 'assets:not-an-image' },
  link: { mimeType: 'text/uri-list', location: 'https://example.com/a?b=c' },
  unclaimed: { mimeType: 'image/png' },
  frame: null,
}

/** A frame's caption, by name; absent is no `label` field. */
const FRAME_LABELS: readonly (string | undefined)[] = [
  'Group A',
  '',
  undefined,
  'A very long group label that cannot fit in a narrow frame at all',
  '日本語のラベルです',
  '👨‍👩‍👧 family',
]

/** What a file node's reference resolves to. */
export type ResolvedWire = {
  readonly label?: string
  readonly missing?: boolean
  readonly image?: { readonly href: string; readonly alt?: string }
} | null

const RESOLVED: readonly ResolvedWire[] = [
  null,
  { missing: true, label: 'ignored' },
  { missing: false, label: 'Doc A' },
  { label: '' },
  { image: { href: 'blob:1', alt: '  ' } },
  { image: { href: 'blob:2', alt: '﻿ A cat 　' } },
  { image: { href: 'blob:3', alt: '\u0085' } },
  { image: { href: 'blob:4' } },
  { label: 'Named', image: { href: 'blob:5', alt: 'alt' } },
  {},
]

/** `[x, y, w, h]`: ordinary, fractional, small, degenerate, negative and non-finite boxes. */
const BOXES: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 160, 100],
  [12.5, -30.25, 240, 60],
  [100, 100, 40, 20],
  [5, 5, 10, 10],
  [0, 0, 16, 16],
  [0, 0, 0, 0],
  [0, 0, -20, 40],
  [0, 0, Number.NaN, 50],
  [0, 0, Number.POSITIVE_INFINITY, 50],
  [3, 4, 1e6, 30],
  [-50, 20, 90, 300],
  [7, 9, 200, 36],
]

const SHAPES: readonly (string | null)[] = [
  null,
  'visual.ellipse',
  'visual.diamond',
  'visual.hexagon',
  'visual.parallelogram',
  'visual.octagon',
  'visual.cylinder',
  'visual.star',
  'other.ellipse',
]

type ThemeName = 'light' | 'dark' | 'sketch'
const THEMES: readonly ThemeName[] = ['light', 'dark', 'sketch']
const ALIGNS: readonly ('start' | 'center' | null)[] = [null, 'start', 'center']
const COLORS: readonly (string | null)[] = [null, '3', '#ff0000']

/** `[padding, label size, minimum content width]`. */
const GEOMETRIES: readonly (readonly [number, number, number])[] = [
  [8, 16, 0],
  [0, 12, 30],
  [20, 16, 0],
  [6, 14, 400],
]

/** A label a box is asked to fit, beside the one the node itself has. */
const PROBE_LABELS: readonly string[] = [
  'Label',
  '',
  'A label far too long to fit inside the narrow content box of this node',
  '漢字かなまじりの長いラベルは途中で切られる',
  '👩🏽‍💻👩🏽‍💻👩🏽‍💻👩🏽‍💻👩🏽‍💻👩🏽‍💻',
  'x',
]

const viaJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function typeset(markdown: string, width: number): readonly SceneNode[] {
  return typesetMdastBlocks(parseMarkdownBody(markdown), {
    measure: createFakeMeasure(),
    maxWidth: width,
    fontFamily: 'sans-serif',
    theme: MARKDOWN_THEME_NODE,
  }).nodes
}

const run = (x: number, y: number, w: number, text: string) => ({
  kind: 'textRun' as const,
  bbox: { x, y, w, h: 16 },
  text,
})

/** The content a node's box places, by name, as data: laid-out bodies and scenes written by hand. */
export function contents(): Readonly<Record<string, readonly SceneNode[]>> {
  const scenes: Record<string, readonly SceneNode[]> = {
    empty: [],
    line: typeset('Hello world', 140),
    wrapped: typeset('The quick brown fox jumps over the lazy dog again and again', 120),
    'heading-paragraph': typeset('# Title\n\nA paragraph under it that wraps twice over', 110),
    list: typeset('- one\n- two words\n  - nested item', 140),
    table: typeset('| a | b |\n| - | - |\n| one | two |', 140),
    tall: typeset(Array.from({ length: 12 }, (_, i) => `Paragraph ${i}`).join('\n\n'), 140),
    every: buildEveryKindScene().nodes,
    label: [{ ...run(0, 0, 50, 'Label'), baseline: 12.8 }],
    'edge-only': buildEveryKindScene().nodes.filter((n) => n.kind === 'edge'),
    'empty-paragraph': [{ kind: 'paragraph', bbox: { x: 0, y: 0, w: 100, h: 20 }, runs: [] }],
    'runs-out-of-order': [
      {
        kind: 'paragraph',
        bbox: { x: 0, y: 2, w: 200, h: 40 },
        runs: [
          run(30, 20, 40, 'second-b'),
          run(-4, 2, 30, 'first-a'),
          run(0, 20, 20, 'second-a'),
          run(40, 2, 90, 'first-b'),
          run(10, 38, 300, 'too wide'),
        ],
      },
      { kind: 'shape', bbox: { x: 0, y: 60, w: 30, h: 10 } },
    ],
    'negative-offset': [
      { kind: 'paragraph', bbox: { x: 5, y: -12, w: 80, h: 16 }, runs: [run(5, -12, 30, 'up')] },
    ],
  }
  return viaJson(scenes)
}

/** A case's options and what it is asked, chosen from its index. */
export interface CaseSpec {
  readonly id: string
  readonly resource: string
  readonly frameLabel: string | null | undefined
  readonly box: readonly [number, number, number, number]
  readonly shape: string | null
  readonly theme: ThemeName
  readonly fitToBox: boolean
  readonly align: 'start' | 'center' | null
  readonly color: string | null
  readonly geometry: readonly [number, number, number]
  readonly resolved: ResolvedWire
  readonly probe: string
  readonly content: string
}

const pick = <T>(list: readonly T[], at: number): T => list[at % list.length] as T

/**
 * Every resource in every box, with a silhouette, theme, alignment, colour,
 * geometry, resolution, probe label and content drawn round-robin at co-prime
 * strides, so each combination is reached without the product; then every box in
 * every silhouette with the fit both on and off, for the content box itself.
 */
export function caseSpecs(): readonly CaseSpec[] {
  const names = Object.keys(RESOURCES)
  const contentNames = Object.keys(contents())
  const specs: CaseSpec[] = []
  let at = 0
  const push = (resource: string, box: CaseSpec['box'], shape: string | null, fit: boolean) => {
    specs.push({
      id: `${specs.length}/${resource}`,
      resource,
      frameLabel: resource === 'frame' ? pick(FRAME_LABELS, at) : null,
      box,
      shape,
      theme: pick(THEMES, at),
      fitToBox: fit,
      align: pick(ALIGNS, at * 5 + 1),
      color: pick(COLORS, at * 7 + 2),
      geometry: pick(GEOMETRIES, at * 3 + 1),
      resolved: pick(RESOLVED, at * 11 + 3),
      probe: pick(PROBE_LABELS, at * 13 + 4),
      content: pick(contentNames, at * 17 + 5),
    })
    at += 1
  }
  for (const resource of names) {
    for (const box of BOXES) push(resource, box, pick(SHAPES, at * 2), at % 5 !== 4)
  }
  for (const box of BOXES) {
    for (const shape of SHAPES) {
      for (const fit of [true, false]) push(pick(names, at), box, shape, fit)
    }
  }
  return specs
}

export const contentScene = (name: string): Scene => ({ nodes: contents()[name] ?? [] })
