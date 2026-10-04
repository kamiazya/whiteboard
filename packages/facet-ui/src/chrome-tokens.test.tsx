import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { POPOVER_SURFACE, SURFACE } from './chrome-tokens.js'

const SOURCES = readdirSync(import.meta.dirname)
  .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
  .map((name) => ({ name, text: readFileSync(join(import.meta.dirname, name), 'utf8') }))

// A host token with its own fallback: the literal is what a bare page shows.
const TOKEN_WITH_LITERAL_FALLBACK = /var\(--[\w-]+\s*,\s*(?:#|rgb|hsl)/

describe('the host-token palette', () => {
  it('is spelled in chrome-tokens.ts and nowhere else in the package', () => {
    const spelled = SOURCES.filter(({ text }) => TOKEN_WITH_LITERAL_FALLBACK.test(text)).map(
      ({ name }) => name,
    )
    expect(spelled).toEqual(['chrome-tokens.ts'])
  })

  it('has sources to scan, and the palette module among them', () => {
    expect(SOURCES.length).toBeGreaterThan(5)
    expect(SOURCES.map(({ name }) => name)).toContain('chrome-tokens.ts')
  })

  it('keeps a popover surface apart from the page surface', () => {
    expect(POPOVER_SURFACE).toContain('--popover')
    expect(SURFACE).not.toContain('--popover')
  })
})
