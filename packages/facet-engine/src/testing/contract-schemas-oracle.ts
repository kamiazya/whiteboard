/**
 * The engine contract's asset schemas and the plugin manifest, answered
 * through their generated Zod and recorded for the Rust interpreter of the
 * same contract files to replay (`crates/core/facet-engine/tests/schema_oracle.rs`).
 * Together they cover the dialect's numbers and bounds, defaults, a union of
 * definitions and a union chosen by a property, so the interpreter is held to
 * Zod over every construct the facet contracts use, not only the visual ones.
 */
import { acceptedOrThrow, arbitraryForSchema } from '@kamiazya/whiteboard-model/test-utils'
import * as fc from 'fast-check'
import type { z } from 'zod'
import { iconAssetSchema, stencilAssetSchema, themeTokensSchema } from '../generated/engine.zod.js'
import { pluginManifestSchema } from '../generated/plugin-manifest.zod.js'
import { brokenVariant, randomFrom } from './broken-variants.js'
import { SAMPLE_THEME_TOKENS } from './sample-theme-tokens.js'
import {
  type Answer,
  answerSchema,
  decode,
  type Encoded,
  encode,
  hasLoneSurrogate,
} from './schema-oracle.js'

export const SCHEMAS = {
  ThemeTokens: themeTokensSchema,
  IconAsset: iconAssetSchema,
  StencilAsset: stencilAssetSchema,
  PluginManifest: pluginManifestSchema,
} as const

export type SchemaName = keyof typeof SCHEMAS
export type RecordedCase = { s: SchemaName; in: Encoded } & Answer

const SAMPLE_MANIFEST = {
  id: 'demo',
  displayName: 'Demo',
  facets: [
    {
      name: 'mark',
      displayName: 'Mark',
      version: 'v1',
      targets: ['node', 'edge'],
      schema: 'facets/demo/demo.schema.json#/$defs/DemoMark',
      assetRefs: { theme: 'themes', icon: 'icons' },
      editor: {
        picker: {
          options: [
            { payload: null, label: 'No mark', glyph: { kind: 'shape', name: 'none' } },
            {
              payload: { tone: 'calm' },
              label: 'Calm',
              keywords: ['quiet'],
              glyph: { kind: 'char', value: 'C' },
            },
            { payload: 1, label: 'Asset', glyph: { kind: 'asset', id: 'demo.thing' } },
            {
              payload: [1, 2.5],
              label: 'Themed',
              glyph: { kind: 'theme', id: 'demo.theme', icon: 'demo.thing' },
            },
          ],
          specimenIcon: 'demo.thing',
          layout: 'cards',
          catalog: {
            label: 'Search marks',
            source: 'demo.marks',
            entry: {
              label: 'Any tone',
              placeholder: 'tone',
              payload: { tone: 'x', '1': 2 },
              field: 'tone',
            },
          },
        },
        fields: {
          tone: {
            widget: 'segmented',
            label: 'Tone',
            quick: true,
            placeholder: 'p',
            layout: 'chips',
            options: [{ value: 'calm', label: 'Calm', glyph: { kind: 'shape', name: 'circle' } }],
          },
          size: { widget: 'number' },
        },
      },
      compat: {
        v0: { schema: 'facets/demo/demo.schema.json#/$defs/DemoMarkOld', migrate: 'demo.v0-to-v1' },
      },
    },
    {
      name: 'plain',
      displayName: 'Plain',
      version: 'v0',
      targets: ['document'],
      schema: 'facets/demo/demo.schema.json#/$defs/Plain',
    },
  ],
  assets: { themes: 'demo.themes', icons: 'demo.icons', stencils: 'demo.stencils' },
}

const SAMPLE_ICON = {
  viewBox: '0 0 24 24',
  geometry: [
    { tag: 'path', d: 'M0 0h24' },
    { tag: 'rect', x: 1, y: 2.5, width: 3, height: 4, rx: 0.5 },
    { tag: 'circle', cx: 1, cy: 2, r: 3 },
    { tag: 'ellipse', cx: -1, cy: 2e-7, rx: 3, ry: 4 },
  ],
}

const SAMPLE_STENCIL = {
  displayName: 'Bucket',
  color: '#336699',
  facets: { 'visual.shape/v0': { kind: 'cylinder' }, 'a.b/v1': [1, { c: null }] },
}

const BASES: Record<SchemaName, readonly unknown[]> = {
  ThemeTokens: [
    SAMPLE_THEME_TOKENS,
    { ...SAMPLE_THEME_TOKENS, strokeWidthPx: 1.5, fontFamily: 'Yomogi', glow: { radiusPx: 4 } },
    {
      ...SAMPLE_THEME_TOKENS,
      defaults: {
        nodeShape: 'visual.diamond',
        edgeRouting: 'curved',
        groupFrame: { strokeDasharray: '4 2', strokeWidth: 2 },
      },
      ink: 'sketch',
    },
  ],
  IconAsset: [SAMPLE_ICON, { geometry: [{ tag: 'path', d: 'M1 1' }] }],
  StencilAsset: [SAMPLE_STENCIL, { displayName: 'x' }],
  PluginManifest: [SAMPLE_MANIFEST, { id: 'a', displayName: 'A', facets: [] }],
}

/** Cases a damage is unlikely to find: a bound exactly met, a grammar corner. */
const HAND_WRITTEN: readonly (readonly [SchemaName, unknown])[] = [
  ['ThemeTokens', { ...SAMPLE_THEME_TOKENS, strokeWidthPx: 0 }],
  ['ThemeTokens', { ...SAMPLE_THEME_TOKENS, strokeWidthPx: -0.5 }],
  ['ThemeTokens', { ...SAMPLE_THEME_TOKENS, strokeWidthPx: 5e-324 }],
  ['ThemeTokens', { ...SAMPLE_THEME_TOKENS, strokeWidthPx: Number.MAX_VALUE }],
  ['ThemeTokens', { ...SAMPLE_THEME_TOKENS, glow: { radiusPx: 0 } }],
  [
    'ThemeTokens',
    { ...SAMPLE_THEME_TOKENS, defaults: { groupFrame: { strokeWidth: 0, strokeDasharray: '' } } },
  ],
  ['ThemeTokens', { ...SAMPLE_THEME_TOKENS, defaults: null }],
  ['ThemeTokens', { ...SAMPLE_THEME_TOKENS, defaults: [] }],
  ['ThemeTokens', { ...SAMPLE_THEME_TOKENS, ink: 'Clean' }],
  ['ThemeTokens', { ...SAMPLE_THEME_TOKENS, fontFamily: '' }],
  ['ThemeTokens', { ink: 'clean' }],
  ['ThemeTokens', { palette: SAMPLE_THEME_TOKENS.palette }],
  ['ThemeTokens', {}],
  ['ThemeTokens', null],
  ['ThemeTokens', 'tokens'],
  [
    'ThemeTokens',
    { ...SAMPLE_THEME_TOKENS, palette: { light: SAMPLE_THEME_TOKENS.palette.light } },
  ],
  ['IconAsset', { geometry: [] }],
  ['IconAsset', { geometry: [{ tag: 'path', d: '' }] }],
  ['IconAsset', { geometry: [{ tag: 'line', x1: 0 }] }],
  ['IconAsset', { geometry: [{ tag: 'rect', x: 1, y: 2, width: 3 }] }],
  ['IconAsset', { geometry: [{ d: 'M0 0' }] }],
  [
    'IconAsset',
    {
      geometry: [
        { tag: 'circle', cx: '1', cy: 2, r: 3 },
        { tag: 'circle', cx: 1, cy: null, r: 3 },
      ],
    },
  ],
  ['IconAsset', { geometry: 'path' }],
  ['IconAsset', { geometry: '' }],
  ['IconAsset', { geometry: { length: 0 } }],
  ['IconAsset', { geometry: { length: 2 } }],
  ['ThemeTokens', { ...SAMPLE_THEME_TOKENS, fontFamily: [] }],
  ['ThemeTokens', { ...SAMPLE_THEME_TOKENS, fontFamily: { length: 0 } }],
  ['IconAsset', { geometry: [null, 3, 'x', []] }],
  ['IconAsset', { viewBox: '', geometry: [{ tag: 'path', d: 'M' }] }],
  ['StencilAsset', { displayName: '' }],
  ['StencilAsset', { displayName: 'x', color: '' }],
  ['StencilAsset', { displayName: 'x', facets: { Bad: 1, '7': 2 } }],
  ['StencilAsset', { displayName: 'x', facets: [] }],
  ['StencilAsset', { displayName: 'x', facets: null }],
  ['StencilAsset', { displayName: 'x', extra: 1, more: 2 }],
  ['StencilAsset', { color: '#fff' }],
  ['PluginManifest', { id: 'Demo', displayName: '', facets: [] }],
  [
    'PluginManifest',
    {
      id: 'demo',
      displayName: 'D',
      facets: [
        {
          name: 'm',
          displayName: 'M',
          version: 'v0',
          targets: [],
          schema: 'facets/a/b.schema.json#/$defs/X',
        },
      ],
    },
  ],
  [
    'PluginManifest',
    {
      id: 'demo',
      displayName: 'D',
      facets: [
        {
          name: 'm',
          displayName: 'M',
          version: 'v0',
          targets: ['zone'],
          schema: 'facets/a/b.schema.json#/$defs/X',
        },
      ],
    },
  ],
  [
    'PluginManifest',
    {
      id: 'demo',
      displayName: 'D',
      facets: [{ name: 'm', displayName: 'M', version: '0', targets: ['node'], schema: 'nope' }],
    },
  ],
  [
    'PluginManifest',
    {
      id: 'demo',
      displayName: 'D',
      facets: [
        {
          name: 'm',
          displayName: 'M',
          version: 'v0',
          targets: ['node'],
          schema: 'facets/a/b.schema.json#/$defs/X',
          editor: { picker: { options: [{ payload: 1, label: 'l', glyph: { kind: 'nothing' } }] } },
        },
      ],
    },
  ],
  [
    'PluginManifest',
    {
      id: 'demo',
      displayName: 'D',
      facets: [
        {
          name: 'm',
          displayName: 'M',
          version: 'v0',
          targets: ['node'],
          schema: 'facets/a/b.schema.json#/$defs/X',
          editor: { picker: { options: [{ payload: 1, label: 'l', glyph: { name: 'circle' } }] } },
        },
      ],
    },
  ],
  [
    'PluginManifest',
    {
      id: 'demo',
      displayName: 'D',
      facets: [
        {
          name: 'm',
          displayName: 'M',
          version: 'v0',
          targets: ['node'],
          schema: 'facets/a/b.schema.json#/$defs/X',
          editor: {
            picker: {
              options: [
                { payload: 1, label: 'l', glyph: { kind: 'shape', name: 'blob' } },
                { payload: 1, label: 'l', glyph: 'shape' },
                { label: 'l', glyph: { kind: 'char', value: '' } },
              ],
            },
          },
        },
      ],
    },
  ],
  ['PluginManifest', { id: 'demo', displayName: 'D', facets: 'none' }],
  [
    'PluginManifest',
    { id: 'demo', displayName: 'D', facets: [], assets: { themes: 'bad', extra: 'x.y' } },
  ],
  ['PluginManifest', []],
  ['PluginManifest', null],
]

function validDraws(name: SchemaName, count: number): unknown[] {
  const schema = SCHEMAS[name] as z.ZodTypeAny
  try {
    const arbitrary = acceptedOrThrow(arbitraryForSchema(schema), () => undefined, name)
    return fc.sample(arbitrary, { numRuns: count })
  } catch {
    return []
  }
}

const SIZES: Record<SchemaName, number> = {
  ThemeTokens: 55,
  IconAsset: 65,
  StencilAsset: 65,
  PluginManifest: 65,
}

/** Every input of the recording, drawn fresh: only a deliberate re-recording calls this. */
export function recordInputs(): (readonly [SchemaName, unknown])[] {
  const inputs: (readonly [SchemaName, unknown])[] = []
  for (const name of Object.keys(SCHEMAS) as SchemaName[]) {
    const drawn = validDraws(name, SIZES[name])
    // The schema fills a theme's `defaults` in, so some valid themes must not carry one.
    const bare =
      name === 'ThemeTokens' ? drawn.slice(0, 12).map(({ defaults: _, ...rest }: any) => rest) : []
    const valid = [...BASES[name], ...drawn, ...bare]
    const seeds = fc.sample(fc.integer({ min: 0, max: 2 ** 31 - 1 }), SIZES[name] * 2)
    const damaged = seeds.map((seed, i) => brokenVariant(valid[i % valid.length], randomFrom(seed)))
    for (const input of [...valid, ...damaged]) inputs.push([name, input])
  }
  inputs.push(...HAND_WRITTEN)
  return inputs.filter(([, input]) => !hasLoneSurrogate(input))
}

export function caseOf(name: SchemaName, input: unknown): RecordedCase {
  return { s: name, in: encode(input), ...answerSchema(SCHEMAS[name] as z.ZodTypeAny, input) }
}

/** The answer a recorded case stands for, asked of today's schemas. */
export function answerAgain(recorded: RecordedCase): RecordedCase {
  return caseOf(recorded.s, decode(recorded.in))
}
