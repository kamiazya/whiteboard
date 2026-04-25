import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return join(tempDir, 'data')
  },
}))

const {
  deletePaletteEntries,
  loadPalette,
  mergePaletteEntries,
} = await import('./palette-store.js')

describe('palette-store', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'palette-store-test-'))
    await mkdir(join(tempDir, 'data'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns an empty palette for an uninitialized session', async () => {
    await expect(loadPalette('session1')).resolves.toEqual({})
  })

  it('mergePaletteEntries adds and overwrites while preserving existing keys', async () => {
    await mergePaletteEntries('session1', { 'plan.a': '#dbeafe' })
    const next = await mergePaletteEntries('session1', {
      'accent.target': '#1971c2',
      'plan.a': '#bfdbfe',
    })
    expect(next).toEqual({
      'accent.target': '#1971c2',
      'plan.a': '#bfdbfe',
    })
  })

  it('deletePaletteEntries removes only the requested keys', async () => {
    await mergePaletteEntries('session1', {
      'plan.a': '#dbeafe',
      'accent.target': '#1971c2',
    })
    const next = await deletePaletteEntries('session1', ['plan.a'])
    expect(next).toEqual({
      'accent.target': '#1971c2',
    })
  })
})
