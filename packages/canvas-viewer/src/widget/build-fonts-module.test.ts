import { describe, expect, it } from 'vitest'
import {
  buildWidgetFontsModuleSource,
  resolveWidgetFontAssets,
  type WidgetFontAsset,
} from './build-fonts-module.js'

describe('resolveWidgetFontAssets', () => {
  it('reads each asset file through the injected reader and encodes it as a woff2 data URI', () => {
    const assets: WidgetFontAsset[] = [
      { family: 'Excalifont', file: 'Excalifont/Excalifont-Regular-abc.woff2' },
    ]
    const bytes = new Uint8Array([1, 2, 3, 4])
    const resolved = resolveWidgetFontAssets(assets, (file) => {
      expect(file).toBe('Excalifont/Excalifont-Regular-abc.woff2')
      return bytes
    })

    expect(resolved).toHaveLength(1)
    expect(resolved[0].family).toBe('Excalifont')
    expect(resolved[0].dataUri).toBe(
      `data:font/woff2;base64,${Buffer.from(bytes).toString('base64')}`,
    )
  })

  it('carries optional weight/style/unicodeRange descriptors through unchanged', () => {
    const assets: WidgetFontAsset[] = [
      {
        family: 'Excalifont',
        file: 'Excalifont/Excalifont-Regular-abc.woff2',
        weight: '400',
        style: 'normal',
        unicodeRange: 'U+20-7e',
      },
    ]
    const resolved = resolveWidgetFontAssets(assets, () => new Uint8Array())

    expect(resolved[0]).toMatchObject({
      weight: '400',
      style: 'normal',
      unicodeRange: 'U+20-7e',
    })
  })
})

describe('buildWidgetFontsModuleSource', () => {
  it('emits a module exporting WIDGET_FONTS with the resolved descriptors', () => {
    const source = buildWidgetFontsModuleSource([
      {
        family: 'Excalifont',
        file: 'Excalifont/Excalifont-Regular-abc.woff2',
        unicodeRange: 'U+20-7e',
        dataUri: 'data:font/woff2;base64,AQIDBA==',
      },
    ])

    expect(source).toContain('export const WIDGET_FONTS')
    expect(source).toContain('"family": "Excalifont"')
    expect(source).toContain('"unicodeRange": "U+20-7e"')
    expect(source).toContain('data:font/woff2;base64,AQIDBA==')
  })
})
