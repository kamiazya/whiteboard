import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { getExcalidrawFontCopyTarget } from './excalidraw-font-assets.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('Excalidraw font asset copy config', () => {
  it('copies font files recursively from the installed package', () => {
    const target = getExcalidrawFontCopyTarget(resolve(__dirname, '../..'))

    expect(target.src.endsWith('/dist/prod/fonts/**/*')).toBe(true)
    expect(existsSync(target.src.replace('/**/*', ''))).toBe(true)
    expect(target.dest).toBe('fonts')
  })
})
