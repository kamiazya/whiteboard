import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { visualPlugin } from './data.js'
import { VISUAL_ICONS } from './icons/icons.js'
import { VISUAL_STENCILS } from './stencils.js'
import { VISUAL_THEMES } from './themes.js'

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

describe('the asset tables, byte for byte', () => {
  it('serialises the themes, stencils and icons as they always have', () => {
    expect(digest(VISUAL_THEMES)).toMatchSnapshot('themes')
    expect(digest(VISUAL_STENCILS)).toMatchSnapshot('stencils')
    expect(digest(VISUAL_ICONS)).toMatchSnapshot('icons')
  })

  it('registers these asset ids in this order, with these values', () => {
    const assets = visualPlugin.assets
    expect({
      themes: Object.keys(assets?.themes ?? {}),
      icons: Object.keys(assets?.icons ?? {}),
      stencils: Object.keys(assets?.stencils ?? {}),
      registered: digest(assets),
    }).toMatchSnapshot('ids')
  })
})
